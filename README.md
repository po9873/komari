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
    mac_address: "02:42:ac:11:00:02"
    networks:
      lan:
        ipv4_address: 192.168.1.100
    volumes:
      - ./data:/app/data
      - ./nginx.conf:/etc/nginx/http.d/default.conf:ro
    environment:
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: 换成你的密码
      TUNNEL_TOKEN: 换成你的隧道Token
      GODEBUG: disablethp=1

networks:
  lan:
    external: true
    name: macvlan0        # 宿主机上已有的 macvlan 网络名
```

这样容器直接以 `192.168.1.100` 出现在局域网里，nginx 的 80/443 直接可访问，不再需要 `ports`。

## 更新

```bash
docker compose pull && docker compose up -d
```

镜像重建后三个进程一起换成新版本。上游 komari / cloudflared / nginx 有新版本时，本仓库的工作流会在每天检查后自动构建新镜像。

## 局域网设备内网上报（可选）

面板生成的安装命令用的是「当前访问地址」。内网设备想直接上报到内网地址、不绕 Cloudflare，不需要装任何浏览器插件——直接利用面板自带的注入点：

1. 面板 → **设置 → 自定义美化 → 自定义 Body**
2. 把 `examples/lan-endpoint.html` 的内容整段粘进去（**不用改任何值**，脚本里不写死任何地址）
3. 保存、刷新面板，第一次勾选时弹框填一次内网地址即可，之后双击勾选框可随时改

之后节点页的「一键部署指令」弹窗里会多一个 **「局域网设备（内网上报）」** 勾选：
- 勾上 → 生成的命令和复制到剪贴板的内容都用内网地址
- 不勾 → 用当前域名（走 Cloudflare 隧道）

脚本只在页面里做文本替换，不联网、不改后端数据。

## 只用 nginx 或只用隧道

想删掉某个进程，就改 `supervisord.conf` 删掉对应的 `[program:xxx]` 段，然后自己 `docker build` 一个镜像。直接用官方镜像则没有任何裁剪。
