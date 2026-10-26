# komari

komari + nginx + cloudflared 打进一个镜像，三个进程由 supervisord 一起拉起。

## 镜像

```
po9873/komari:latest
```

## 容器里跑什么

| 进程 | 监听 | 作用 |
|---|---|---|
| komari | `127.0.0.1:25775` | 面板本体，只在容器内部，不对外 |
| nginx | `80` | 反代到 `127.0.0.1:25775` |
| cloudflared | — | 用 `TUNNEL_TOKEN` 建隧道，回源 `127.0.0.1:25775` |

## 部署

### 1. 准备目录和反代配置

```bash
mkdir -p komari/data && cd komari

cat > nginx.conf <<'EOF'
server {
    listen 80;
    client_max_body_size 50m;

    # 内网直连时跳到容器自己的内网地址，避免绕 Cloudflare 再回来。
    # 不需要这个功能可以整段删掉，也能正常用。
    if ($wb_redirect_lan) {
        return 302 http://$wb_lan_authority$request_uri;
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
EOF
```

要上 TLS 就在这个文件里加 `listen 443 ssl;` 和证书路径，再把证书目录挂进容器。

注意挂载目标是 `/etc/nginx/http.d/default.conf`：镜像里的 nginx 是 alpine 的包，只读 `http.d/*.conf`，`conf.d/` 不生效。

### 2. 写 compose.yml

```yaml
services:
  komari:
    image: po9873/komari:latest
    container_name: komari
    restart: unless-stopped
    ports:
      - "80:80"                   # 换成 "8080:80" 就用 8080 访问
    volumes:
      - ./data:/app/data
      - ./nginx.conf:/etc/nginx/http.d/default.conf:ro
    environment:
      ADMIN_USERNAME: admin       # 首次启动时创建的管理员
      ADMIN_PASSWORD: 换成你的密码
      TUNNEL_TOKEN: 换成你的隧道Token
      GODEBUG: disablethp=1
```

`TUNNEL_TOKEN` 必填：cloudflared 靠它建隧道，留空会导致 supervisord 拉不起这个进程。

### 3. 启动

```bash
docker compose up -d
docker compose logs -f --tail=50
```

### 4. 验证

```bash
docker compose ps
docker exec komari sh -c 'ps | grep -E "komari|nginx|cloudflared" | grep -v grep'
curl -I http://127.0.0.1/
```

三个进程都在、`curl` 返回 `200` 或 `302` 就算起来了。

### 5. 固定 IP / MAC（macvlan）

需要容器在局域网里占固定 IP 时，把 `ports` 去掉，改成挂 macvlan 网络（示例值，换成你自己网络的）：

```yaml
services:
  komari:
    image: po9873/komari:latest
    container_name: komari
    restart: unless-stopped
    mac_address: "02:00:00:00:00:01"   # 示例值（本地管理地址），换成你自己的
    networks:
      lan:
        ipv4_address: 192.0.2.10          # 示例值（RFC 5737 文档专用），换成你自己的
    volumes:
      - ./data:/app/data
      - ./nginx.conf:/etc/nginx/http.d/default.conf:ro
    environment:
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: 换成你的密码
      TUNNEL_TOKEN: 换成你的隧道Token
      GODEBUG: disablethp=1
      KOMARI_LAN_AUTO: "1"        # 打开内网直连（见下一节）

networks:
  lan:
    external: true
    name: macvlan0        # 宿主机上已有的 macvlan 网络名
```

这样容器直接以你指定的 IP 出现在局域网里，nginx 的 80/443 直接可访问，不再需要 `ports`。

上面两处用的是文档示例值（`192.0.2.0/24` 是 RFC 5737 保留给文档的网段，不属于任何人的内网），换成你自己网络的地址即可。

## 局域网访问不再绕 Cloudflare

这是镜像自带的行为，**不需要装任何浏览器插件，也不用往面板里粘脚本**。

面板生成的安装命令，用的是「当前访问的那个地址」。所以只要面板是通过内网地址打开的，命令天然就是内网地址。镜像做的是把「内网用域名打开」这一种情况也自动导到内网地址上：

| 你从哪访问 | 结果 |
|---|---|
| 公网、走 Cloudflare | 不跳转，安装命令用域名 |
| 内网、直接用 `http://容器IP` 打开 | 不跳转，命令本来就是 IP（komari 原生行为） |
| 内网、用域名打开（内网 DNS 已指向容器） | 自动跳到 `http://容器IP`，命令变成 IP |

判断依据是请求头里有没有 `CF-Ray`：有就是 Cloudflare 送来的（公网），没有就是内网直连。容器自己的 IP 在启动时自动探测，**镜像里没有任何写死的地址**。

打开方式：

```yaml
    environment:
      KOMARI_LAN_AUTO: "1"
```

可选的两个覆盖项：

| 变量 | 默认 | 作用 |
|---|---|---|
| `KOMARI_LAN_HOST` | 自动探测容器 IPv4 | 想手动指定跳转目标时填 |
| `KOMARI_LAN_PORT` | 跟随 nginx 实际监听端口 | 对外端口和 nginx 监听端口不一致时才需要填（比如外面映射成 8080） |

**前提：内网的设备得能直接连到容器。** 这一步在网络层，镜像替不了：

- 方案一（最省事）：内网直接用 `http://容器IP` 打开面板，什么都不用配。
- 方案二：在路由器 / 内网 DNS（dnsmasq、AdGuard Home 之类）上加一条记录，把面板域名指向容器 IP：

  ```
  # 主机记录            记录值
  你的面板域名          容器IP
  ```

  之后内网用域名打开会自动落到 IP，公网那边照旧走隧道，两边互不影响。

注意 `KOMARI_LAN_AUTO` 只在容器有**内网可达的 IP** 时才有意义（macvlan 或 host 网络）。默认的 bridge + `ports` 映射，容器 IP 是 `172.x`，内网其它设备连不上，别开。

如果之前往面板「设置 → 自定义美化 → 自定义 Body」里粘过切换地址的脚本，升级后请把那段清空：镜像是服务端直接换地址，脚本再改一遍会互相打架。

## 更新

```bash
docker compose pull && docker compose up -d
```

镜像重建后三个进程一起换成新版本。上游 komari / cloudflared / nginx 有新版本时，本仓库的工作流会在每天检查后自动构建新镜像。

## 只用 nginx 或只用隧道

想删掉某个进程，就改 `supervisord.conf` 删掉对应的 `[program:xxx]` 段，然后自己 `docker build` 一个镜像。直接用官方镜像则没有任何裁剪。
