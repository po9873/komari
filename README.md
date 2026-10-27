# komari

komari + nginx + cloudflared + acme.sh（证书签发/续期）打进一个镜像，四个进程由 supervisord 一起拉起。

证书这件事不另外起容器：nginx 就在这个镜像里，续期完直接在本容器 `nginx -s reload`，不需要 `docker.sock`、不需要 `docker exec`。

## 镜像

```
po9873/komari:latest
```

## 容器里跑什么

| 进程 | 监听 | 作用 |
|---|---|---|
| komari | `127.0.0.1:25775` | 面板本体，只在容器内部，不对外 |
| nginx | `80` / `443` | 反代到 `127.0.0.1:25775` |
| cloudflared | — | 用 `TUNNEL_TOKEN` 建隧道。回源地址在 Cloudflare 面板里配，要指向 **nginx**（80 / 25774 / 443 都行），不要指向 komari 的 25775 |
| acme.sh | — | 配了 `KOMARI_ACME_ENABLED=1` 才工作：签证书、到期前自动续、renew 后自己 reload nginx。没配就直接退出，不占资源 |

## 部署

### 1. 准备目录和反代配置

```bash
mkdir -p komari/{data,certs,acme,acme-sh} && cd komari

cat > nginx.conf <<'EOF'
server {
    listen 80;
    client_max_body_size 50m;

    # 只有开了 KOMARI_LAN_AUTO 才会生效；没开时这个变量恒为 0，等于没写
    if ($wb_redirect_lan) {
        return 302 http://$wb_lan_authority$request_uri;
    }

    # 证书验证文件走这里：acme.sh 把 token 写进 /acme，
    # CA 来抓 http://你的域名/.well-known/acme-challenge/<token>
    # 不开 ACME 时留着也没影响
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
EOF
```

要上 TLS 就在这个文件后面再追一段 443（证书由镜像里的 acme.sh 自己签发、自己写进 `/certs`，**你不用先准备证书**）：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name komari.example.com;

    ssl_certificate     /certs/fullchain.pem;
    ssl_certificate_key /certs/privkey.pem;

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

内网也用 `https://域名` 访问时这段不能省，原因见「内网也用 https 打开，为什么还必须有证书」。

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
      - "443:443"                 # 内网要用 https://域名 直连容器就得开
    volumes:
      - ./data:/app/data
      - ./nginx.conf:/etc/nginx/http.d/default.conf:ro
      - ./certs:/certs            # 证书目录：acme.sh 写、nginx 读，必须可写
      - ./acme:/acme              # 验证文件：acme.sh 写、nginx 读，必须可写
      - ./acme-sh:/acme.sh        # acme.sh 的账号与续期记录，不挂则每次重建都重新注册
    environment:
      ADMIN_USERNAME: admin       # 首次启动时创建的管理员
      ADMIN_PASSWORD: 换成你的密码
      TUNNEL_TOKEN: 换成你的隧道Token
      GODEBUG: disablethp=1
      # ── 证书：这两行配齐就自动签 + 自动续 + 自动 reload ──
      KOMARI_ACME_ENABLED: "1"
      KOMARI_ACME_DOMAIN: komari.example.com
      KOMARI_ACME_EMAIL: you@example.com    # 建议填，CA 的到期提醒会发到这里
```

`TUNNEL_TOKEN` 必填：cloudflared 靠它建隧道，留空会导致 supervisord 拉不起这个进程。

不需要 https、证书那块想自己管的，把 `443:443` 和 `certs` / `acme` / `acme-sh` 三行挂载、以及三个 `KOMARI_ACME_*` 一起删掉即可，其余不变。

### 3. 启动

```bash
docker compose up -d
docker compose logs -f --tail=50
```

### 4. 验证

```bash
docker compose ps
docker exec komari sh -c 'ps | grep -E "komari|nginx|cloudflared" | grep -v grep'
docker exec komari supervisorctl status          # acme 在没配 ACME 时显示 EXITED 是正常的
curl -I http://127.0.0.1/
```

三个常驻进程都在、`curl` 返回 `200` 或 `302` 就算起来了。

## 挂载说明（哪个能删、哪个不能）

镜像本身只依赖一个目录：`/app/data`。其余挂载都是**你自己那份 `nginx.conf` 里写了路径**、或者开了内置 ACME 才需要的。

| 容器内路径 | 要不要挂 | 判断依据 |
|---|---|---|
| `/app/data` | **必须** | 数据库、插件、主题、节点密钥都在这里，不挂等于每次重建都清空 |
| `/etc/nginx/http.d/default.conf` | 想改反代配置就**必须** | 用镜像自带的默认配置可以不挂；挂载目标不能写成 `conf.d/`，alpine 的 nginx 不读那里 |
| `/certs` | 配了 443 就**必须** | conf 里有 `ssl_certificate` 就一定要挂。**注意必须可写**（不要 `:ro`）：开了内置 ACME 时由 acme.sh 往里写证书 |
| `/acme` | 开了内置 ACME 就**必须** | conf 里有 `location /.well-known/acme-challenge/ { root /acme; }` 就一定要挂，且**必须可写**——acme.sh 往这里写验证文件，nginx 读给 CA 看 |
| `/acme.sh` | 开了内置 ACME 就**建议** | acme.sh 的账号、每个域名的续期记录都在这里。不挂也能续，但容器重建后要重新注册账号 |
| `/icons` | **可选** | 只有 conf 里存在 `location /icons/ { alias /icons/; }` 且页面确实引用这些图片时才需要 |

几个最常见的坑：

- **删 `/certs` 会直接让面板打不开**：不是少个功能，是 nginx 起不来。要走这条得同时把 conf 里的 `listen 443 ssl` 和证书配置删掉。
- **把 `/certs` 或 `/acme` 挂成 `:ro`**：容器能起来，但续期时写不进去，90 天后证书原地过期、内网 https 突然报错。这种失效不会报警。
- **删 `/acme` 当天没有任何感觉，60 天后才炸**：站点照常跑，但挑战文件写不进来（nginx 那边 404）。
- **删 `/icons` 是安全的**：`alias` 指向不存在的目录，nginx 照样启动，只是那些路径返回 404。

第一次启动时 `/certs` 是空的，而 conf 里已经有 `listen 443 ssl`——这时镜像会**先放一张 7 天自签占位证书**让 nginx 能起来，acme.sh 签下正式证书后覆盖它并 reload。所以你不用再「先删 443 段、签完再加回去」。

## 内网也用 `https://域名` 打开，为什么还必须有证书

因为内网直连时，**Cloudflare 根本不在链路上**。浏览器访问 `https://komari.example.com`，DNS 被解析到容器 IP 后，TLS 握手的对端就是容器里的 nginx，不是 Cloudflare 边缘。公网方向那张证书由 Cloudflare 出示，内网方向没人替你出，只能容器自己出 —— 所以：

- `/certs` 必须挂，conf 里必须写 `listen 443 ssl` 和 `ssl_certificate`
- 里面必须是**这个域名签发**的证书（Let's Encrypt 之类公共 CA）。自签证书在浏览器里是红锁，节点上装 agent 用 `curl` 拉安装脚本时会直接失败
- 证书换掉后由镜像自己 `nginx -s reload`，不用你手动执行、也不用重建容器

反过来说，什么时候不需要证书：内网只用 `http://容器IP:端口` 访问，那 443 和 `/certs` 都可以不要。

这也决定了下面三选一里该选哪个：内网访问方式是 `https://域名`，**不要开 B**（它会 302 跳到 `http://IP`，等于丢掉 https 和域名）。A（默认开）只是把安装命令里的面板地址换成你当前访问用的地址，用域名打开时命令仍是域名，不影响 https；用 IP 打开时才变成 IP，那是你主动用 IP 访问的结果。

## 证书自动续期（镜像内置 acme.sh）

`/certs` 里的证书 90 天到期。到期没换，公网看着一切正常（那是 Cloudflare 边缘的证书），但**内网用 `https://域名` 会当天开始报错**——那一跳的证书就是容器里这一份。

这个镜像里已经带了 acme.sh，**不需要另起 acme 容器、不需要装 certbot、不需要 `docker.sock`**：

- 首次启动自动签发，之后每 24 小时检查一次，到期前 30 天内自动换
- 换完直接在本容器 `nginx -s reload`，新证书立刻生效
- 只用 HTTP-01（`--webroot`）：验证文件落在 `/acme`，由你 conf 里的 `location /.well-known/acme-challenge/` 喂给 CA

配两个环境变量就开了：

```yaml
    environment:
      KOMARI_ACME_ENABLED: "1"
      KOMARI_ACME_DOMAIN: komari.example.com
      KOMARI_ACME_EMAIL: you@example.com     # 建议填，CA 的到期提醒发这里
```

| 变量 | 默认 | 作用 |
|---|---|---|
| `KOMARI_ACME_ENABLED` | `0` | 设 `1` 才签发/续期；不设就完全不碰 `/certs` |
| `KOMARI_ACME_DOMAIN` | 空 | 要签的域名（单个），必填 |
| `KOMARI_ACME_EMAIL` | 空 | 账号邮箱，建议填 |
| `KOMARI_ACME_WEBROOT` | `/acme` | 验证文件目录，要和 conf 里的 `root` 一致 |
| `KOMARI_ACME_CERTS` | `/certs` | 证书落盘目录，要和 conf 里的 `ssl_certificate` 一致 |
| `KOMARI_ACME_SERVER` | `letsencrypt` | 也可 `zerossl` / `buypass` / `google` |
| `KOMARI_ACME_STAGING` | `0` | 设 `1` 用测试环境（浏览器不认，只验流程用） |
| `KOMARI_ACME_INTERVAL` | `86400` | 检查间隔（秒） |

### 证书是你自己签的，镜像里一份都不带

- `/certs` 初始就是**空目录**，镜像不带证书、不带私钥、不带任何人的域名
- `/acme` 也只是一个**空目录**，专门放验证文件；谁签证书就往里写，跟别人毫无关系
- 本文里的 `komari.example.com`、`192.0.2.10`、`you@example.com` 全是占位符，换成你自己的
- 每个人签自己的：你的域名只认你的验证文件，别人的 `/acme` 和 `/certs` 在别人的机器上，互不可见、互不影响

### 首次签发：不用再「先删 443 段」

以前 `/certs` 空着而 conf 里写着 `listen 443 ssl`，nginx 会直接起不来，只能先删 443、签完再加回来。现在不用了：

1. 启动时如果 `KOMARI_ACME_ENABLED=1` 且 `/certs` 里没有证书，镜像会**先放一张 7 天自签占位证书**，nginx 照样起得来
2. acme.sh 签发成功后把正式证书写进 `/certs` 并 reload，占位证书被覆盖
3. `curl -I https://你的域名` 返回 200，且 `openssl x509` 看到的是 Let's Encrypt，就成了

看进度：

```bash
docker logs komari 2>&1 | grep '\[acme\]'
```

正常依次是 `首次签发 ...` → `签发完成，/certs/fullchain.pem 已就位` → 之后每天 `检查续期`。

### 签发失败时按这三条查

看到 `[acme] 签发失败，10 分钟后重试`，按顺序确认：

1. **域名是否指向这个容器**：`nslookup komari.example.com` 要落到能访问到 nginx 的地址（公网走隧道也算）
2. **验证路径是否通**：`curl -i http://komari.example.com/.well-known/acme-challenge/probe` 必须返回 **nginx 的 404**（说明请求到了源站、只是文件不存在）。返回 CF 的 301/403 页面就是被 CF 挡了
3. **`/acme` 挂了没、可写吗**：`:ro` 会写不进去

域名挂在 Cloudflare 上**不影响**这个流程：CF 默认把 `/.well-known/acme-challenge/` 原样透传到源站，不改写也不拦（已实测过）。

### 想自己管证书（不用内置 ACME）

把 `KOMARI_ACME_ENABLED` 留空或设 `0`，镜像就完全不碰 `/certs`。自己签的文件照样放 `/certs/fullchain.pem` + `/certs/privkey.pem`，nginx 照读。

续期如果在外面的容器或宿主机上跑，注意三件事：

1. `/certs`、`/acme` 两边都别挂 `:ro`（外面要写）
2. 客户端的目标路径要写成容器内的 `/certs/...`、`/acme`，并且和 compose 里的 bind 目标一一对应
3. 换完要 reload 容器里的 nginx：`docker exec komari nginx -s reload`

DNS-01（不需要 80 端口、不需要 `/acme`）的写法：

```bash
curl https://get.acme.sh | sh -s email=you@example.com
export CF_Token="你的 Cloudflare API Token"

~/.acme.sh/acme.sh --issue --dns dns_cf -d komari.example.com \
  --key-file       /你的路径/certs/privkey.pem \
  --fullchain-file /你的路径/certs/fullchain.pem \
  --reloadcmd      "docker exec komari nginx -s reload"
```

`acme.sh` 安装时自己写好 cron，之后每 60 天换一次并执行 `--reloadcmd`。

> 旧版本那段「用 `neilpang/acme.sh` 常驻容器 + 挂 `docker.sock`」的做法**已经去掉**：镜像里本来就有 nginx 和 acme.sh，再单开一个容器是多余的，而且挂 `docker.sock` 等于把宿主机 root 交出去。已经在跑的话，`docker rm -f acme-renew` 停掉它，改配上面两个环境变量即可（`./acme`、`./certs`、`./acme-sh` 这三个目录可以直接复用，续期记录都在里面）。

### 验证续期是真的会跑

别等 90 天。内置 acme.sh 可以直接强制续一次，看它有没有真换证书、有没有 reload：

```bash
# 先看当前证书到期时间
docker exec komari openssl x509 -in /certs/fullchain.pem -noout -subject -dates

# 强制续期
docker exec komari /acme.sh/acme.sh --renew -d komari.example.com --force
docker logs komari --tail=30 | grep '\[acme\]'

# 再看一次，notAfter 应该往后推了
docker exec komari openssl x509 -in /certs/fullchain.pem -noout -dates
docker exec komari nginx -t
```

`notAfter` 推到新日期、日志里有 `nginx 已 reload，新证书生效`，就说明整条链路（签发 → 落盘 → reload）都通。到期前 30 天还没变，就是续期挂了——盯这一条就够。

### 宿主机上如果还留着老的续期任务，先关掉

内置 ACME 和外面的 certbot / acme.sh cron 同时跑会互相覆盖 `/certs`。切换前先查一遍宿主机：

```bash
crontab -l 2>/dev/null | grep -Ei 'acme|certbot'
systemctl list-timers --all 2>/dev/null | grep -i certbot
```

有就注释掉/停掉，再配 `KOMARI_ACME_ENABLED=1`。如果本来就在用外置客户端、不想换，那就把 `KOMARI_ACME_ENABLED` 留空，按上一节「想自己管证书」走。

## 局域网访问不绕 Cloudflare

面板生成的安装命令，用的是「你在浏览器里访问的那个地址」。所以内网设备如果用域名打开面板，复制出来的命令就是域名 —— 内网机器装 agent 时会先出公网、绕一圈 Cloudflare 再回来，慢且容易失败。

镜像提供三种解法，**按需选**：

| 做法 | 开关 | 效果 | 适合 |
|---|---|---|---|
| A. 安装命令自动改用当前访问地址 | 默认开，无需配置 | 用内网地址打开面板→命令用内网地址；用公网域名打开→命令用公网域名。**页面上没有任何控件** | 内网、公网机器都要装 |
| A+. 部署弹窗里给一个内网勾选框 | `KOMARI_LAN_TOGGLE=1`（建议同时给 `KOMARI_LAN_PORT`） | 「一键部署指令」的「安装选项」里多一条「安装命令用内网地址」，勾上即用内网地址、取消即还原；只在弹窗里出现 | 同一个面板，有时要给内网机器装、有时要给公网机器装 |
| B. 自动跳转 | `KOMARI_LAN_AUTO=1` | 内网用域名打开会自动跳到 `http://容器IP` | 只在局域网用面板 |
| C. 内网 DNS 加一条本地记录 | 不用镜像参与 | 域名始终是域名，内网直接连容器，https 不变 | 内网也用 `https://域名` 打开 |

三种都要求**内网的设备能直接连到容器**（容器接了 macvlan / host 网络之类）。默认的 bridge + `ports` 映射，容器 IP 是 `172.x`，内网其它机器连不上，这几个都别开。

### A. 安装命令自动改用当前访问地址（默认开，无 UI）

前端**没有任何勾选框、浮层、多出来的按钮**，页面和原版一模一样。功能由一段注入脚本静默完成：

- 你用什么地址打开面板，安装命令就用什么地址
- 用 `https://komari.example.com` 打开 → 命令里是 `https://komari.example.com`（agent 走公网/隧道）
- 用 `http://192.0.2.10:8080` 打开 → 命令变成 `http://192.0.2.10:8080`（agent 直连内网、不绕 Cloudflare）
- 改的是命令里的面板地址：下载脚本的 URL 不动，只换 `-e` / `--endpoint` 后面那个地址
- 地址**不写死**：镜像里没有任何 IP / 域名，取的是浏览器此刻的 `location.origin`。别人拉这个镜像跑，拿到的是他自己的地址
- 用公网域名打开时，换前换后相同，等于不改，无害

`KOMARI_LAN_INJECT=0` 可以关掉这段注入（关掉后命令永远是面板默认的域名）。

#### 怎么确认它在生效

页面上看不到它，只能在 Console 里问：

```js
__WB_LAN__        // 勾选框模式（KOMARI_LAN_DEBUG=1 时才有这个变量）
```

- 没有这个变量 ⇒ 页面是旧的（Ctrl+Shift+R 强制刷新），或没开 `KOMARI_LAN_DEBUG`
- 打开节点页看安装命令的 `-e` 后面是不是当前访问地址
- 「复制」拿到的文本也被同步改写，不只是显示好看

### A+. 部署弹窗里的「安装命令用内网地址」勾选框（`KOMARI_LAN_TOGGLE=1`）

既想默认安静、又偶尔要内网地址时用它：**只在「一键部署指令」弹窗里**多一行，别的地方什么都没有。

```yaml
environment:
  KOMARI_LAN_TOGGLE: "1"
  KOMARI_LAN_PORT: "25774"     # 内网直连用的端口（容器里 komari 的端口，不是 nginx 的）
```

- 位置：弹窗里「安装选项」那组的**最后一行**，样式和原生那几条选项完全一致（同一套 Radix 组件类名）
- 文案：只有 `安装命令用内网地址` —— **界面上不显示具体 IP / 端口**。IP 和端口是每台部署各自不同的（容器 IP、nginx 端口都不一样），钉在页面上的那个值对别人就是错的；想知道实际换成了什么地址，看命令框里的 `-e` 就行
- 默认值：**默认勾上**（域名打开、内网 IP 打开都一样）。很多人在局域网里也是用域名打开面板，按「访问地址是不是内网 IP」判断默认值会让这个选项永远默认不勾
- 想默认用域名：`KOMARI_LAN_DEFAULT=0`，或者手动取消一次（会记在浏览器里）
- 勾上：命令框里的面板地址实时换成内网地址，**点「复制」拿到的是改写后的**
- 取消：原样还原成面板自己生成的命令
- 地址来源：容器启动时自动识别（探测容器 IPv4 + `KOMARI_LAN_PORT`）；自动识别的不对（比如 agent 在别的网段、想走主机名），点勾选框旁边的「**改**」自己填一个，支持主机名。界面上不显示任何 IP/端口，填的地址只存在你自己的浏览器里
- 记忆：选择存在浏览器 `localStorage`，刷新还在
- 弹窗一关控件就随 DOM 消失，仪表盘/设置页等其它页面**不会出现任何多出来的东西**

内网地址是容器启动时探测的；探测不到时不插这一行（不会给一个假地址）。要换成别的地址（比如走主机名、别的端口），用 `KOMARI_LAN_HOST` / `KOMARI_LAN_PORT` 覆盖，`KOMARI_LAN_HOST` 可以直接填主机名。

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

### C. 内网 DNS 加一条静态记录（不用开上面两个）

要做的只有一件事：**在内网某台 DNS 上，把面板域名直接解析到容器 IP**，别让它去问公网。

```
komari.example.com   →   192.0.2.10
```

不要求特定设备、特定固件、特定品牌。唯一的前提是**你内网里有一层 DNS 允许加本地记录** —— 单独跑的内网 DNS 服务、路由/DHCP 自带的解析功能、NAS 上的解析服务、Linux 上跑的解析服务、甚至单台机器的 hosts，加在哪一层效果都一样。哪层方便用哪层，不需要为了这个换设备。

两种形态，按你手上有的来：

**形态一：有界面，表格里填「域名 + 地址」**

界面上能填「域名 / 主机名」和「IP / 目标地址」两栏的就是它。入口名字各家不一样，可能在 DNS 重写、本地 DNS、静态域名、主机映射、Hosts、DHCP 静态分配里面 —— 名字不重要，有这两栏就是同一个功能。

**形态二：写配置文件，加一行**

dnsmasq 及沿用同一配置语法的实现（大量路由固件、NAS、Linux 发行版的底层都是它）：

```
address=/komari.example.com/192.0.2.10
```

写进主配置或配置目录下任意一个新文件，然后重启那个 DNS 服务。用 BIND 这类 zone 文件的，就加一条普通 A 记录，效果一样。

**形态三：先在一台机器上验证（hosts）**

不想动任何服务时用这个，改完只是这一台生效：

```
# Linux / macOS: /etc/hosts      Windows: C:\Windows\System32\drivers\etc\hosts
192.0.2.10    komari.example.com
```

加完的效果：

- 内网设备解析 → `192.0.2.10`，直连容器，443 证书照样有效，不碰 Cloudflare
- 公网设备解析 → Cloudflare 的地址，走隧道
- 面板里复制出来的命令一直是 `https://komari.example.com/install.sh ...`，两边都能装，不用切换

**怎么确认改对了**（改的是哪一层，就问哪一层）：

```bash
nslookup komari.example.com 你的内网DNS地址    # 应该返回 192.0.2.10
nslookup komari.example.com 223.5.5.5          # 应该返回 Cloudflare 的地址
```

两条结果不一样，才说明本地解析生效了。若是同一个结果，说明客户端没走那台 DNS，或者记录没生效。

这种方式镜像不参与，`KOMARI_LAN_INJECT=0` 和 `KOMARI_LAN_AUTO` 都留空/关掉即可。

### 可选覆盖项

| 变量 | 默认 | 作用 |
|---|---|---|
| `KOMARI_LAN_INJECT` | `1` | 设 `0` 关掉整个「安装命令改写」的注入（勾选框也一起没了） |
| `KOMARI_LAN_TOGGLE` | `0` | 设 `1` 在「一键部署指令」弹窗里加「安装命令用内网地址」勾选框 |
| `KOMARI_LAN_HOST` | 自动探测容器 IPv4 | 手动指定内网地址，**可以填主机名**（如 `komari.lan`）；勾选框和 B 模式都用它 |
| `KOMARI_LAN_PORT` | `80`（勾选框）/ 跟随 nginx（B） | 勾选框用的内网端口（默认 80/443 不会写进地址）。注意填 nginx 的端口，不是 komari 内部端口 |
| `KOMARI_LAN_DEFAULT` | `1` | 勾选框默认是否勾上。设 `0` 则默认用域名（适合只想用域名装 agent 的部署） |
| `KOMARI_LAN_DEBUG` | `0` | 设 `1` 时暴露 `window.__WB_LAN__` 便于排查（生产别开） |

### 实现说明

- 容器自己的 IP 是启动时用 `ip -4 addr` 探测的，镜像里**没有任何写死的 IP、域名、MAC**
- 改写脚本（`lan-toggle.js`）随镜像打包，由 nginx `sub_filter` 在返回页面时插到 `</body>` 前；不需要浏览器插件，也不用往面板「自定义美化」里粘代码
- 静默模式（默认）**不创建任何 DOM 元素**——没有 shadow root、没有浮动层，只改 textarea 的值和剪贴板内容
- 勾选框模式只创建**一行**：`安装选项` 那组末尾的一个勾选行，弹窗移除时随之消失
- 光写 `textarea.value` 不够：面板是 React 受控组件，下一次重渲染会用自己 state 里的原命令把 DOM 盖回去。脚本因此在 textarea 上劫持了 `value` 的 setter——面板每次回写都被拦下改写，原始命令另存一份用于「取消勾选还原」
- 地址取浏览器 `location.origin`（静默）或启动探测的容器 IP（勾选框），不是镜像写死的；换台机器、换种访问方式，改写的都是各自正确的地址
- B 模式（302 跳转）只有显式设 `KOMARI_LAN_AUTO=1` 才会写进 nginx 配置

如果之前往面板「设置 → 自定义美化 → 自定义 Body」里粘过切换地址的脚本，请把那段清空——现在由镜像统一处理，两段一起跑会互相覆盖。

### 前端脚本的测试

`tests/lan-toggle.test.js` 用 jsdom 1:1 复刻面板弹窗的 DOM 结构，覆盖：勾选框位置/默认值、`-e` 改写、GitHub 下载地址不被误改、取消还原、React 重渲染后自动重写、公网域名访问默认不勾、无弹窗页面零新增元素、静默模式、剪贴板改写。

```bash
npm i --no-save jsdom
node tests/lan-toggle.test.js            # 测仓库里的 lan-toggle.js
node tests/lan-toggle.test.js /path/js   # 测指定文件（CI 里测的是从镜像里抠出来的那份）
```

CI 每次构建都会跑它，断言的是镜像里真正被注入的那份脚本。

## 更新

```bash
docker compose pull && docker compose up -d
```

镜像重建后进程一起换成新版本（`/acme.sh` 里是续期记录、`/certs` 里是证书，都挂了卷不会丢）。上游 komari / cloudflared / nginx 有新版本时，本仓库的工作流会在每天检查后自动构建新镜像；acme.sh 在构建时从官方仓库拉当前版本。

## 只用 nginx 或只用隧道

想删掉某个进程，就改 `supervisord.conf` 删掉对应的 `[program:xxx]` 段，然后自己 `docker build` 一个镜像。直接用官方镜像则没有任何裁剪。
