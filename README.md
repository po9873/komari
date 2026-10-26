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

    # 只有开了 KOMARI_LAN_AUTO 才会生效；没开时这个变量恒为 0，等于没写
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

## 局域网访问不绕 Cloudflare

面板生成的安装命令，用的是「你在浏览器里访问的那个地址」。所以内网设备如果用域名打开面板，复制出来的命令就是域名 —— 内网机器装 agent 时会先出公网、绕一圈 Cloudflare 再回来，慢且容易失败。

镜像提供三种解法，**任选一种**，都默认关闭：

| 做法 | 要打开什么 | 效果 | 适合 |
|---|---|---|---|
| A. 面板里给一个勾选框 | `KOMARI_LAN_TOGGLE=1` | 手动切换，看得见状态 | 内网、公网机器都要装 |
| B. 自动跳转 | `KOMARI_LAN_AUTO=1` | 内网用域名打开会自动跳到 `http://容器IP` | 只在局域网用面板 |
| C. 内网 DNS 静态解析 | 不用镜像参与 | 域名始终是域名，内网直接连容器 | 想保持 https + 域名 |

三种都要求**内网的设备能直接连到容器**（容器接了 macvlan / host 网络之类）。默认的 bridge + `ports` 映射，容器 IP 是 `172.x`，内网其它机器连不上，这三个都别开。

### A. 面板里的勾选框（`KOMARI_LAN_TOGGLE`）

打开后，面板右下角会出现一个小开关：

```
☑ 安装命令用内网地址   192.0.2.10:8080
```

- 勾上：节点页里显示的命令、点「复制」拿到的内容，全部换 `http://192.0.2.10:8080` 形式
- 取消：回到域名形式
- 选择存在浏览器 `localStorage`，下次打开还是上次的状态
- 只改安装命令这类文本，不动页面其它内容

```yaml
    environment:
      KOMARI_LAN_TOGGLE: "1"      # 打开勾选框
      KOMARI_LAN_PORT: "8080"     # 勾选后命令里的端口，默认 80
```

**给公网机器装节点时把勾去掉**，不然它会被指向一个连不上的内网地址。

### B. 自动跳转（`KOMARI_LAN_AUTO`）

不显示任何界面元素，内网用域名打开时直接 302 到容器内网地址：

| 你从哪访问 | 结果 |
|---|---|
| 公网、走 Cloudflare | 不跳转，安装命令用域名 |
| 内网、直接用 `http://容器IP` 打开 | 不跳转，命令本来就是 IP |
| 内网、用域名打开 | 跳到 `http://容器IP:端口`，命令变成 IP |

判断依据是请求头里有没有 `CF-Ray`：有就是 Cloudflare 送来的（公网），没有就是内网直连。

```yaml
    environment:
      KOMARI_LAN_AUTO: "1"
```

`nginx.conf` 里需要有那段 `if ($wb_redirect_lan)`，见「部署」第 1 步。

### C. 内网 DNS 静态解析（不用开上面两个）

如果你更希望「命令永远显示域名」，就在路由器或内网 DNS 上把面板域名指向容器 IP。这样内网解析到容器、公网解析到 Cloudflare，一份命令内网外网通用。

在 dnsmasq / AdGuard Home / OpenWrt / iKuai 这类设备上加一条静态解析（**下面是 RFC 5737 文档示例，换成自己的**）：

```
# 域名                     指向
komari.example.com        192.0.2.10
```

- 内网设备解析 → `192.0.2.10`，直连容器，443 证书照样有效，不碰 Cloudflare
- 公网设备解析 → Cloudflare 的地址，走隧道
- 面板里复制出来的命令一直是 `https://komari.example.com/install.sh ...`，两边都能装

这种方式镜像不参与，`KOMARI_LAN_TOGGLE` 和 `KOMARI_LAN_AUTO` 都留空即可。

### 可选覆盖项

| 变量 | 默认 | 作用 |
|---|---|---|
| `KOMARI_LAN_HOST` | 自动探测容器 IPv4 | 想手动指定内网地址时填 |
| `KOMARI_LAN_PORT` | `80`（A）/ 跟随 nginx 端口（B） | 对外端口和 nginx 监听端口不一致时填 |

### 实现说明

- 容器自己的 IP 是启动时用 `ip -4 addr` 探测的，镜像里**没有任何写死的 IP、域名、MAC**
- 勾选框那段脚本随镜像打包（`lan-toggle.js`），由 nginx `sub_filter` 在返回首页时插到 `</body>` 前，**不需要装浏览器插件，也不用往面板「自定义美化」里粘代码**
- 两种模式同时开时以勾选框为准（A 优先），B 不会生效

如果之前往面板「设置 → 自定义美化 → 自定义 Body」里粘过切换地址的脚本，请把那段清空，否则会和镜像自带的开关打架。

## 更新

```bash
docker compose pull && docker compose up -d
```

镜像重建后三个进程一起换成新版本。上游 komari / cloudflared / nginx 有新版本时，本仓库的工作流会在每天检查后自动构建新镜像。

## 只用 nginx 或只用隧道

想删掉某个进程，就改 `supervisord.conf` 删掉对应的 `[program:xxx]` 段，然后自己 `docker build` 一个镜像。直接用官方镜像则没有任何裁剪。
