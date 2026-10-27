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
| acme.sh | — | 默认自动工作：识别到域名（现有证书 CN / CF 隧道配置）且 nginx 引用了 `/certs`，就签发、到期前自动续、renew 后自己 reload nginx。`KOMARI_ACME_ENABLED=0` 可关掉 |

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
    # CA 会请求 http://<域名>/.well-known/acme-challenge/<token>
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

要启用 TLS 就在该文件后追加一段 443（证书由镜像内的 acme.sh 自行签发并写入 `/certs`，无需预先准备）：

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

内网也以 `https://域名` 访问时该段不能省略，原因见「内网也用 `https://域名` 打开，为什么还必须有证书」。

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
      ADMIN_PASSWORD: <管理员密码>
      TUNNEL_TOKEN: <隧道 Token>
      GODEBUG: disablethp=1
      # 证书那块不用配：域名从 /certs 现有证书或 CF 隧道配置里自动识别
      # 想固定域名 / 收 CA 到期提醒再加这两行
      # KOMARI_ACME_DOMAIN: komari.example.com
      # KOMARI_ACME_EMAIL: you@example.com
```

`TUNNEL_TOKEN` 必填：cloudflared 靠它建隧道，留空会导致 supervisord 拉不起这个进程。

不使用 https、证书自行管理时，删除 `443:443` 与 `certs` / `acme` / `acme-sh` 三行挂载，并设置 `KOMARI_ACME_ENABLED: "0"`，其余不变。

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

三个常驻进程均在、`curl` 返回 `200` 或 `302` 即启动完成。

## 挂载说明（哪个能删、哪个不能）

镜像本身只依赖一个目录：`/app/data`。其余挂载由 **`nginx.conf` 中引用的路径**、或启用内置 ACME 决定。

| 容器内路径 | 要不要挂 | 判断依据 |
|---|---|---|
| `/app/data` | **必须** | 数据库、插件、主题、节点密钥都在这里，不挂等于每次重建都清空 |
| `/etc/nginx/http.d/default.conf` | 想改反代配置就**必须** | 用镜像自带的默认配置可以不挂；挂载目标不能写成 `conf.d/`，alpine 的 nginx 不读那里 |
| `/certs` | 配了 443 就**必须** | conf 里有 `ssl_certificate` 就一定要挂。**注意必须可写**（不要 `:ro`）：开了内置 ACME 时由 acme.sh 往里写证书 |
| `/acme` | 开了内置 ACME 就**必须** | conf 里有 `location /.well-known/acme-challenge/ { root /acme; }` 就一定要挂，且**必须可写**——acme.sh 往这里写验证文件，nginx 读给 CA 看 |
| `/acme.sh` | 开了内置 ACME 就**建议** | acme.sh 的账号、每个域名的续期记录都在这里。不挂也能续，但容器重建后要重新注册账号 |
| `/icons` | **可选** | 只有 conf 里存在 `location /icons/ { alias /icons/; }` 且页面确实引用这些图片时才需要 |

几个最常见的坑：

- **删除 `/certs` 会直接导致面板无法访问**：nginx 无法启动。采用该方式需同时移除 conf 中的 `listen 443 ssl` 与证书配置。
- **把 `/certs` 或 `/acme` 挂成 `:ro`**：容器能起来，但续期时写不进去，90 天后证书原地过期、内网 https 突然报错。这种失效不会报警。
- **删除 `/acme` 不会立即报错，约 60 天后证书续期才会失败**：站点照常运行，但挑战文件写不进来（nginx 返回 404）。
- **删除 `/icons` 是安全的**：`alias` 指向不存在的目录时 nginx 仍可正常启动，仅这些路径返回 404。

## 内网以 `https://域名` 访问为何仍需证书

内网直连时 **Cloudflare 不在链路上**。浏览器访问 `https://komari.example.com`，DNS 被解析到容器 IP 后，TLS 握手的对端就是容器里的 nginx，不是 Cloudflare 边缘。公网方向的证书由 Cloudflare 出示，内网方向没有中间方，只能由容器自身提供：

- `/certs` 必须挂，conf 里必须写 `listen 443 ssl` 和 `ssl_certificate`
- 其中必须是**为该域名签发**的证书（Let's Encrypt 等公共 CA）。自签证书在浏览器中显示为不安全，节点安装 agent 时用 `curl` 拉取安装脚本会直接失败
- 证书更新后由镜像自行 `nginx -s reload`，无需手动执行，也无需重建容器

不需要证书的情况：内网只用 `http://容器IP:端口` 访问时，443 与 `/certs` 均可省略。

据此选择下文三种做法：内网访问方式为 `https://域名` 时**不要启用 B**（它会把请求 302 到 `http://IP`，丢掉 https 与域名）。A 只改写安装命令中的面板地址，以域名访问时命令仍是域名，不影响 https；以 IP 访问时才写成 IP。

## 证书自动续期（镜像内置 acme.sh）

`/certs` 里的证书 90 天到期。到期未更换时公网访问看似正常（出示的是 Cloudflare 边缘证书），但**内网以 `https://域名` 访问会当天开始报错**，该链路的证书即容器内这一份。

这个镜像里已经带了 acme.sh，**不需要另起 acme 容器、不需要装 certbot、不需要 `docker.sock`**：

- 首次启动自动签发，之后每 24 小时检查一次，到期前 30 天内自动换
- 换完直接在本容器 `nginx -s reload`，新证书立刻生效
- 只用 HTTP-01（`--webroot`）：验证文件落在 `/acme`，通过 conf 里的 `location /.well-known/acme-challenge/` 提供给 CA

**什么都不用配**：域名会自动识别，顺序是

1. `/certs` 里已有证书的 CN —— 续期、重启都认得出，最稳
2. cloudflared 日志里的远端隧道配置 —— 用 CF 托管隧道时，后台配的 hostname 会打在日志里，全新部署靠这条
3. 都没有才需要手动填 `KOMARI_ACME_DOMAIN`

```yaml
    environment:
      # 通常一条都不用写；想固定域名 / 收 CA 到期提醒时才加
      KOMARI_ACME_DOMAIN: komari.example.com   # 可选，留空就自动识别
      KOMARI_ACME_EMAIL: you@example.com       # 可选，建议填
```

| 变量 | 默认 | 作用 |
|---|---|---|
| `KOMARI_ACME_ENABLED` | `auto` | `auto`＝nginx 引用了 `/certs` 就签；`0` 完全不碰 `/certs`；`1` 强制签 |
| `KOMARI_ACME_DOMAIN` | 空（自动识别） | 只在自动识别不对时才需要填 |
| `KOMARI_ACME_EMAIL` | 空 | 账号邮箱，建议填 |
| `KOMARI_ACME_WEBROOT` | `/acme` | 验证文件目录，要和 conf 里的 `root` 一致 |
| `KOMARI_ACME_CERTS` | `/certs` | 证书落盘目录，要和 conf 里的 `ssl_certificate` 一致 |
| `KOMARI_ACME_SERVER` | `letsencrypt` | 也可 `zerossl` / `buypass` / `google` |
| `KOMARI_ACME_STAGING` | `0` | 设 `1` 用测试环境（浏览器不认，只验流程用） |
| `KOMARI_ACME_INTERVAL` | `86400` | 检查间隔（秒） |
| `KOMARI_CFD_LOG` | `/var/log/cloudflared.log` | 从哪读 CF 隧道配置，排障时可改 |

识别结果随时可查：

```bash
docker exec komari acme-renew.sh --resolve-only
# [acme] 识别到域名：mb.example.com（来源：CF 隧道配置）
```

### 证书由部署方自签，镜像不含任何证书

- `/certs` 初始就是**空目录**，镜像不带证书、不带私钥、不带任何人的域名
- `/acme` 同样只是**空目录**，用于存放验证文件，由各部署自行写入
- 本文中的 `komari.example.com`、`192.0.2.10`、`you@example.com` 均为占位符，按实际值替换
- **仓库与镜像内均不含任何域名**：域名只在运行时读取，来源是 `/certs` 中证书的 CN 与 cloudflared 日志中的隧道配置，代码里没有写死的域名
- acme.sh 的 ECC 证书记录在 `<域名>_ecc` 目录，RSA 才是 `<域名>`。`acme_domain_dir` 两者都识别，避免重启后把已签发状态误判为首次签发而重复申请。目录名由 `$DOMAIN` 拼接，对任意域名一致
- `sh scripts/guard-public.sh`：公开库泄漏自检，扫描被 git 跟踪的文件，白名单之外的 IP、token/私钥形态、非占位符密码一律报错。CI 的 `check` job 第一步执行，未通过则不构建、不推镜像

### 首次签发的占位证书

`/certs` 为空而 conf 里写着 `listen 443 ssl` 时，nginx 会因找不到证书而无法启动。镜像的处理顺序是：

1. 启动时若 `/certs` 内无证书、而 conf 中 `listen 443 ssl` 指向它，镜像**先放一张 7 天自签占位证书**（域名尚未识别时 CN 暂用 `komari.local`），nginx 可正常启动
2. acme.sh 签发成功后把正式证书写入 `/certs` 并 reload，占位证书被覆盖

验证：`curl -I https://<域名>` 返回 200，且 `openssl x509` 显示签发者为 Let's Encrypt。

查看进度：

```bash
docker logs komari 2>&1 | grep '\[acme\]'
```

正常依次是 `首次签发 ...` → `签发完成，/certs/fullchain.pem 已就位` → 之后每天 `检查续期`。

### 签发失败时按这三条查

出现 `[acme] 签发失败，10 分钟后重试` 时，按顺序检查：

1. **域名是否指向这个容器**：`nslookup komari.example.com` 要落到能访问到 nginx 的地址（公网走隧道也算）
2. **验证路径是否通**：`curl -i http://komari.example.com/.well-known/acme-challenge/probe` 必须返回 **nginx 的 404**（说明请求到了源站、只是文件不存在）。返回 CF 的 301/403 页面就是被 CF 挡了
3. **`/acme` 挂了没、可写吗**：`:ro` 会写不进去

域名托管在 Cloudflare 上**不影响**该流程：CF 默认将 `/.well-known/acme-challenge/` 原样透传到源站，不改写也不拦截。

### 自行管理证书（不启用内置 ACME）

将 `KOMARI_ACME_ENABLED` 设为 `0` 后，镜像不再读写 `/certs`。自签证书仍放至 `/certs/fullchain.pem` 与 `/certs/privkey.pem`，nginx 照常读取。

续期在外置容器或宿主机上执行时，需注意三点：

1. `/certs`、`/acme` 两边都别挂 `:ro`（外面要写）
2. 客户端的目标路径要写成容器内的 `/certs/...`、`/acme`，并且和 compose 里的 bind 目标一一对应
3. 换完要 reload 容器里的 nginx：`docker exec komari nginx -s reload`

DNS-01（不需要 80 端口、不需要 `/acme`）的写法：

```bash
curl https://get.acme.sh | sh -s email=you@example.com
export CF_Token="<Cloudflare API Token>"

~/.acme.sh/acme.sh --issue --dns dns_cf -d komari.example.com \
  --key-file       /path/to/certs/privkey.pem \
  --fullchain-file /path/to/certs/fullchain.pem \
  --reloadcmd      "docker exec komari nginx -s reload"
```

`acme.sh` 安装时自己写好 cron，之后每 60 天换一次并执行 `--reloadcmd`。

> 早期版本采用 `neilpang/acme.sh` 常驻容器并挂载 `docker.sock`，该方式已移除：镜像内已有 nginx 与 acme.sh，单独起容器多余，且挂载 `docker.sock` 等同于交出宿主机 root。若该容器仍在运行，`docker rm -f acme-renew` 停用后即可由内置 ACME 接管，`./acme`、`./certs`、`./acme-sh` 三个目录可直接复用，续期记录在其中。

### 验证续期是否生效

无需等到 90 天后验证。强制续期一次即可确认签发、落盘、reload 是否都正常：

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

`notAfter` 后移、日志出现 `nginx 已 reload，新证书生效`，说明签发 → 落盘 → reload 全链路正常。若到期前 30 天内 `notAfter` 仍未变化，即续期未生效。

### 宿主机上残留的续期任务

内置 ACME 和外面的 certbot / acme.sh cron 同时跑会互相覆盖 `/certs`。切换前先查一遍宿主机：

```bash
crontab -l 2>/dev/null | grep -Ei 'acme|certbot'
systemctl list-timers --all 2>/dev/null | grep -i certbot
```

有则注释或停用，内置 ACME 默认接管。若仍需使用外置客户端，将 `KOMARI_ACME_ENABLED` 设为 `0`，按上一节「自行管理证书」处理。

## 局域网访问不绕 Cloudflare

面板生成的安装命令使用浏览器当前访问的地址。内网设备以域名打开面板时，复制出的命令即为域名，内网机器安装 agent 会绕经 Cloudflare 出公网再返回，延迟高且容易失败。

镜像提供三种解法，**按需选**：

| 做法 | 开关 | 效果 | 适合 |
|---|---|---|---|
| A. 安装命令自动改用当前访问地址 | 默认开，无需配置 | 用内网地址打开面板→命令用内网地址；用公网域名打开→命令用公网域名。**页面上没有任何控件** | 内网、公网机器都要装 |
| A+. 部署弹窗里给一个内网勾选框 | 默认就有，不用配 | 「一键部署指令」的「安装选项」里多一条「安装命令用内网地址」，勾上即用内网地址、取消即还原；只在弹窗里出现 | 同一个面板，有时要给内网机器装、有时要给公网机器装 |
| B. 自动跳转 | `KOMARI_LAN_AUTO=1` | 内网用域名打开会自动跳到 `http://容器IP` | 只在局域网用面板 |
| C. 内网 DNS 加一条本地记录 | 不用镜像参与 | 域名始终是域名，内网直接连容器，https 不变 | 内网也用 `https://域名` 打开 |

三种方式都要求**内网设备能直接连到容器**（容器使用 macvlan / host 网络等）。默认 bridge + `ports` 映射下容器 IP 为 `172.x`，内网其它机器无法直连，这几种方式均不适用。

### A. 安装命令自动改用当前访问地址（默认开，无 UI）

前端**没有任何勾选框、浮层、多出来的按钮**，页面和原版一模一样。功能由一段注入脚本静默完成：

- 安装命令跟随访问面板所用的地址
- 用 `https://komari.example.com` 打开 → 命令里是 `https://komari.example.com`（agent 走公网/隧道）
- 用 `http://192.0.2.10:8080` 打开 → 命令变成 `http://192.0.2.10:8080`（agent 直连内网、不绕 Cloudflare）
- 改的是命令里的面板地址：下载脚本的 URL 不动，只换 `-e` / `--endpoint` 后面那个地址
- 地址**不写死**：镜像内不含任何 IP / 域名，取自浏览器当前的 `location.origin`，不同部署各自得到自己的地址
- 用公网域名打开时，换前换后相同，等于不改，无害

`KOMARI_LAN_INJECT=0` 可关闭该注入（关闭后命令始终为面板默认地址）。

#### 生效确认

页面不显示状态，可在 Console 查看：

```js
__WB_LAN__        // 勾选框模式（KOMARI_LAN_DEBUG=1 时才有这个变量）
```

- 缺少该变量 ⇒ 页面为缓存版本（强制刷新），或未开启 `KOMARI_LAN_DEBUG`
- 打开节点页看安装命令的 `-e` 后面是不是当前访问地址
- 「复制」拿到的文本也被同步改写，不只是显示好看

### A+. 部署弹窗里的「安装命令用内网地址」勾选框（默认开启）

**不用配任何变量**：镜像默认就有这一行。只在「一键部署指令」弹窗里出现，别的地方什么都没有。

- 位置：弹窗里「安装选项」那组的**最后一行**，样式和原生那几条选项完全一致（同一套 Radix 组件类名）
- 文案：`安装命令用内网地址`，**界面上不显示具体 IP / 端口**。地址随部署而异，写死在页面上对其它部署即为错误值；实际替换结果见命令框中的 `-e`
- 默认值：**勾选**，与访问方式无关。若按「访问地址是否为内网 IP」决定默认值，局域网内以域名访问时该选项将始终不勾选
- 想默认用域名：`KOMARI_LAN_DEFAULT=0`，或者手动取消一次（会记在浏览器里）
- 想彻底关掉这一行：`KOMARI_LAN_TOGGLE=0`
- 勾上：命令框里的面板地址实时换成内网地址，**点「复制」拿到的是改写后的**
- 取消：原样还原成面板自己生成的命令
- 地址来源：**全自动**——容器 IPv4 启动时探测，端口从挂进来的 nginx 配置里读（跳过 `443 ssl`，优先非 80 的明文端口，比如 `listen 25774`）。自动识别的不对（比如 agent 在别的网段、想走主机名），点勾选框旁的「**改**」可手动指定，支持主机名。界面上不显示任何 IP/端口，填写的地址仅保存在浏览器 `localStorage`
- 记忆：选择存在浏览器 `localStorage`，刷新还在
- 弹窗一关控件就随 DOM 消失，仪表盘/设置页等其它页面**不会出现任何多出来的东西**

内网地址由容器启动时探测；探测不到时不插入该行，不使用猜测值。需要指定时用 `KOMARI_LAN_HOST` / `KOMARI_LAN_PORT` 覆盖，`KOMARI_LAN_HOST` 可填主机名。

### B. 自动跳转（`KOMARI_LAN_AUTO`）

不显示任何界面元素，内网用域名打开时直接 302 到容器内网地址：

| 访问来源 | 结果 |
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

### C. 内网 DNS 添加静态记录（不使用上述两种方式）

要做的只有一件事：**在内网某台 DNS 上，把面板域名直接解析到容器 IP**，别让它去问公网。

```
komari.example.com   →   192.0.2.10
```

不限定设备、固件或品牌。前提是**内网中存在一层可添加本地记录的 DNS** —— 独立内网 DNS 服务、路由/DHCP 自带的解析功能、NAS 上的解析服务、Linux 上的解析服务、单机 hosts 均可，加在哪一层效果相同。

两种形态：

**形态一：有界面，表格里填「域名 + 地址」**

界面上能填「域名 / 主机名」和「IP / 目标地址」两栏的就是它。入口名字各家不一样，可能在 DNS 重写、本地 DNS、静态域名、主机映射、Hosts、DHCP 静态分配里面 —— 名字不重要，有这两栏就是同一个功能。

**形态二：写配置文件，加一行**

dnsmasq 及沿用同一配置语法的实现（大量路由固件、NAS、Linux 发行版的底层都是它）：

```
address=/komari.example.com/192.0.2.10
```

写进主配置或配置目录下任意一个新文件，然后重启那个 DNS 服务。用 BIND 这类 zone 文件的，就加一条普通 A 记录，效果一样。

**形态三：先在一台机器上验证（hosts）**

仅需单机验证、不改动任何服务时使用，改动只对该机器生效：

```
# Linux / macOS: /etc/hosts      Windows: C:\Windows\System32\drivers\etc\hosts
192.0.2.10    komari.example.com
```

加完的效果：

- 内网设备解析 → `192.0.2.10`，直连容器，443 证书仍然有效，不经过 Cloudflare
- 公网设备解析 → Cloudflare 的地址，走隧道
- 面板里复制出来的命令一直是 `https://komari.example.com/install.sh ...`，两边都能装，不用切换

**验证方式**（查询哪一层即确认哪一层）：

```bash
nslookup komari.example.com <内网DNS地址>      # 应返回 192.0.2.10
nslookup komari.example.com 223.5.5.5          # 应该返回 Cloudflare 的地址
```

两条结果不同才说明本地解析生效；结果相同则说明客户端未使用该 DNS，或记录未生效。

该方式镜像不参与，`KOMARI_LAN_INJECT` 与 `KOMARI_LAN_AUTO` 保持默认或关闭即可。

### 可选覆盖项

| 变量 | 默认 | 作用 |
|---|---|---|
| `KOMARI_LAN_INJECT` | `1` | 设 `0` 关掉整个「安装命令改写」的注入（勾选框也一起没了） |
| `KOMARI_LAN_TOGGLE` | `1`（开） | 设 `0` 去掉「一键部署指令」弹窗里的勾选框，只保留命令改写 |
| `KOMARI_LAN_HOST` | 自动探测容器 IPv4 | 手动指定内网地址（覆盖探测），**可以填主机名**（如 `komari.lan`） |
| `KOMARI_LAN_PORT` | 自动读 nginx 的 `listen` | 只有自动识别不对时才填。注意填 nginx 的明文端口，不是 komari 内部端口 |
| `KOMARI_LAN_DEFAULT` | `1` | 勾选框默认是否勾上。设 `0` 则默认用域名（适合只想用域名装 agent 的部署） |
| `KOMARI_LAN_DEBUG` | `0` | 设 `1` 时额外暴露 `window.__WB_LAN__` 与改写日志（`__WB_LAN_STATE__` 不用开也一直有） |

### 实现说明

- 容器自己的 IP 是启动时用 `ip -4 addr` 探测的，镜像里**没有任何写死的 IP、域名、MAC**
- 改写脚本（`lan-toggle.js`）随镜像打包，由 nginx `sub_filter` 在返回页面时插到 `</body>` 前；不需要浏览器插件，也不用往面板「自定义美化」里粘代码
- 静默模式（默认）**不创建任何 DOM 元素**——没有 shadow root、没有浮动层，只改 textarea 的值和剪贴板内容
- 勾选框模式只创建**一行**：`安装选项` 那组末尾的一个勾选行，弹窗移除时随之消失
- 光写 `textarea.value` 不够：面板是 React 受控组件，下一次重渲染会用自己 state 里的原命令把 DOM 盖回去。脚本因此在 textarea 上劫持了 `value` 的 setter——面板每次回写都被拦下改写，原始命令另存一份用于「取消勾选还原」
- 「安装选项」这一行的插入位置不写死单一路径，按上游 DOM 做**多级退路**（上游改版时不致直接失效）：
  1. 认标题文案（`安装选项` / `安装参数` / `Install options`），插到它后面的格子 —— 正常情况走这条
  2. 标题外面多包了一层 → 往上层继续找兄弟
  3. 标题整个没了 → 按弹窗里的勾选控件反推它们共同的父容器
  4. 结构完全认不出 → 插在命令框上方（位置略差，功能还在）
- 动手前有一道闸门：**命令框里必须确实是安装命令**（`install.sh` / `install.ps1` / `komari-agent` / `--endpoint` / `-e http…`），或弹窗标题写着「一键部署」。别的弹窗、别的页面一个元素都不插
- React 重建了选项格子时，脚本会把失效的旧行清掉重插，**不会出现两行**
- 地址取浏览器 `location.origin`（静默）或启动探测的容器 IP（勾选框），不是镜像写死的；换台机器、换种访问方式，改写的都是各自正确的地址

#### 插入状态确认（上游改版排查）

页面不显示状态，可在控制台查询：

```js
__WB_LAN_STATE__
// { mode: "toggle", lanOrigin: "http://192.0.2.10:8080", dialog: true, row: true, anchor: "title-next" }
```

- `row: true` ⇒ 这一行确实插进了弹窗；`row: false` + `anchor: "none"` ⇒ 上游结构变了、四条退路都没认出来（这时内网改写仍然生效，只是没有勾选框）
- `anchor` 记录走的是哪条路：`title-next`（正常）/ `title-up`（标题被包了一层）/ `checkbox-cluster`（标题没了）/ `before-textarea`（结构完全变了）/ `skip:not-deploy`（当前弹窗不是部署弹窗，故意不插）
- `dialog: false` ⇒ 弹窗没打开，属于正常

- B 模式（302 跳转）只有显式设 `KOMARI_LAN_AUTO=1` 才会写进 nginx 配置

若面板「设置 → 自定义美化 → 自定义 Body」中已有切换地址的脚本，需清空：镜像已统一处理，两段同时运行会互相覆盖。

### 前端脚本的测试

`tests/lan-toggle.test.js` 用 jsdom 1:1 复刻面板弹窗的 DOM 结构，覆盖：勾选框位置与默认勾选状态、`-e` 改写、GitHub 下载地址不被误改、取消后还原、React 重渲染后自动重写、无弹窗页面零新增元素、静默模式、剪贴板内容同步。

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
