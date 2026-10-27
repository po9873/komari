# komari

komari 面板 + nginx + cloudflared + acme.sh 打包成一个镜像（`po9873/komari:latest`），四个进程由 supervisord 一起拉起。

- 面板只监听容器内的 `127.0.0.1:25775`，对外由 nginx 反代
- 证书在镜像内签发和续期，不需要另起 acme 容器、不需要 `docker.sock`
- 域名、内网端口都自动识别，compose 里不用写

## 快速开始

```bash
mkdir -p komari/{data,certs,acme,acme-sh} && cd komari
```

`nginx.conf`（挂载到 `/etc/nginx/http.d/default.conf`）：

```nginx
server {
    listen 80;
    client_max_body_size 50m;

    location /.well-known/acme-challenge/ {
        root /acme;
        default_type text/plain;
    }

    location / {
        proxy_pass http://127.0.0.1:25775;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

需要 https 时追加第二段（`location` 与上面完全相同）：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name komari.example.com;        # 换成实际域名

    ssl_certificate     /certs/fullchain.pem;
    ssl_certificate_key /certs/privkey.pem;

    location / { ... }                     # 复制 80 段里的 location
}
```

`compose.yml`：

```yaml
services:
  komari:
    image: po9873/komari:latest
    container_name: komari
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./data:/app/data
      - ./nginx.conf:/etc/nginx/http.d/default.conf:ro
      - ./certs:/certs
      - ./acme:/acme
      - ./acme-sh:/acme.sh
    environment:
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: <管理员密码>
      TUNNEL_TOKEN: <隧道 Token>
      GODEBUG: disablethp=1
```

启动并确认：

```bash
docker compose up -d
docker compose logs -f --tail=50
docker compose ps
curl -I http://127.0.0.1/
```

## 证书

不用配。启动时按「`/certs` 里已有证书的 CN → cloudflared 日志里的隧道 hostname」识别域名，首次签发后每 24 小时检查，到期前 30 天自动续，换完自己 `nginx -s reload`。

```bash
docker exec komari acme-renew.sh --resolve-only   # 看识别到的域名
docker logs komari 2>&1 | grep acme               # 看签发/续期过程
```

想自己签就设 `KOMARI_ACME_ENABLED=0`，把证书放 `/certs/fullchain.pem` + `/certs/privkey.pem`。

## 内网访问

内网设备用域名打开面板时，复制出的安装命令是域名，装 agent 会绕 Cloudflare 出去再回来。镜像默认在「一键部署指令」弹窗的安装选项里加一行**安装命令用内网地址**，勾上后命令换成内网地址：

- 地址自动识别（容器 IP + nginx 的明文端口），界面上不显示
- 识别不对时点旁边的「改」手动填，支持主机名
- 默认勾选；不要这一行设 `KOMARI_LAN_TOGGLE=0`

内网用 `https://域名` 访问需要另配内网 DNS，见 [docs/advanced.md](docs/advanced.md#局域网访问)。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | 首次启动创建的管理员 |
| `TUNNEL_TOKEN` | — | cloudflared 隧道 Token，必填 |
| `KOMARI_ACME_ENABLED` | `auto` | `auto`＝nginx 引用了 `/certs` 就签；`0` 关闭 |
| `KOMARI_ACME_DOMAIN` | 自动识别 | 固定域名时才填 |
| `KOMARI_ACME_EMAIL` | 空 | CA 到期提醒邮箱 |
| `KOMARI_LAN_TOGGLE` | `1` | 设 `0` 去掉内网勾选框 |
| `KOMARI_LAN_DEFAULT` | `1` | 设 `0` 则勾选框默认不勾 |
| `KOMARI_LAN_HOST` / `KOMARI_LAN_PORT` | 自动识别 | 覆盖探测到的内网地址 |

其余变量、三种内网方案、挂载取舍、实现细节见 [docs/advanced.md](docs/advanced.md)。

## 排障

| 现象 | 先看 |
|---|---|
| 面板打不开 | `docker exec komari nginx -t`，多半是 `/certs` 空而 conf 里写了 `listen 443 ssl` |
| 证书没签下来 | `docker logs komari 2>&1 \| grep acme` |
| 内网勾选框不见了 | 浏览器控制台 `__WB_LAN_STATE__`，看 `row` 与 `anchor` |
| 进程少了一个 | `docker exec komari supervisorctl status` |

## 更新

```bash
docker compose pull && docker compose up -d
```

`/app/data`、`/certs`、`/acme.sh` 都挂了卷，重建不丢。上游有新版本时本仓库工作流会每天检查并自动构建镜像。
