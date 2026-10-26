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
| cloudflared | — | 用 `TUNNEL_TOKEN` 建隧道。回源地址在 Cloudflare 面板里配，要指向 **nginx**（80 / 25774 / 443 都行），不要指向 komari 的 25775 |

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

要上 TLS 就在这个文件里加 `listen 443 ssl;` 和证书路径，再把证书目录挂进容器。内网也用 `https://域名` 访问时这步不能省，原因见「内网也用 https 打开，为什么还必须有证书」。

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

## 挂载说明（哪个能删、哪个不能）

镜像本身只依赖一个目录：`/app/data`。其余挂载都是**你自己那份 `nginx.conf` 里写了路径**才需要的，不是镜像要求的。

| 容器内路径 | 要不要挂 | 判断依据 |
|---|---|---|
| `/app/data` | **必须** | 数据库、插件、主题、节点密钥都在这里，不挂等于每次重建都清空 |
| `/etc/nginx/http.d/default.conf` | 想改反代配置就**必须** | 用镜像自带的默认配置可以不挂；挂载目标不能写成 `conf.d/`，alpine 的 nginx 不读那里 |
| `/certs` | 配了 443 就**必须** | conf 里有 `ssl_certificate` 就一定要挂，否则 `nginx -t` 报找不到文件、nginx 起不来。内网用 `https://域名` 直连容器也属于这种情况，见下一节 |
| `/acme` | 走 HTTP-01 续期就**必须** | conf 里有 `location /.well-known/acme-challenge/ { root /acme; }` 就一定要挂，否则挑战文件 404、续期静默失败，90 天后证书过期内网 https 才炸。走 DNS-01 不需要，见「证书自动续期」 |
| `/icons` | **可选** | 只有 conf 里存在 `location /icons/ { alias /icons/; }` 且页面确实引用这些图片时才需要 |

两个最常见的坑：

- **删 `/certs` 会直接让面板打不开**：不是少个功能，是 nginx 起不来。要走这条得同时把 conf 里的 `listen 443 ssl` 和证书配置删掉。
- **删 `/acme` 当天没有任何感觉，60 天后才炸**：站点照常跑，但续期时挑战文件写不进来（nginx 那边 404），证书到 90 天原地过期。这种失效不会报警，只会在某天内网 https 突然报错。
- **删 `/icons` 是安全的**：`alias` 指向不存在的目录，nginx 照样启动，只是那些路径返回 404。

带 TLS 的完整示例（4 个挂载，路径和域名都是示例值；走 DNS-01 续期的话 `/acme` 那行可以删）：

```yaml
services:
  komari:
    image: po9873/komari:latest
    container_name: komari
    restart: always
    volumes:
      - ./data:/app/data
      - ./nginx.conf:/etc/nginx/http.d/default.conf:ro
      - ./certs:/certs:ro
      - ./acme:/acme:ro            # 走 HTTP-01 webroot 续期才需要，见「证书自动续期」
    environment:
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: 换成你的密码
      TUNNEL_TOKEN: 换成你的隧道Token
      GODEBUG: disablethp=1
```

对应的 `nginx.conf` 里 443 段：

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

证书续期不归这个镜像管，但**不能不配**：证书 90 天到期，到期那天内网 `https://域名` 就开始报错。走 HTTP-01 需要额外挂 `/acme`，走 DNS-01 不需要 —— 具体步骤见下面的「证书自动续期」。

## 内网也用 `https://域名` 打开，为什么还必须有证书

因为内网直连时，**Cloudflare 根本不在链路上**。浏览器访问 `https://komari.example.com`，DNS 被解析到容器 IP 后，TLS 握手的对端就是容器里的 nginx，不是 Cloudflare 边缘。公网方向那张证书由 Cloudflare 出示，内网方向没人替你出，只能容器自己出 —— 所以：

- `/certs` 必须挂，conf 里必须写 `listen 443 ssl` 和 `ssl_certificate`
- 里面必须是**这个域名签发**的证书（Let's Encrypt 之类公共 CA）。自签证书在浏览器里是红锁，节点上装 agent 用 `curl` 拉安装脚本时会直接失败
- 证书续期后 `docker exec komari nginx -s reload` 一次就生效，不用重建容器

反过来说，什么时候不需要证书：内网只用 `http://容器IP:端口` 访问，那 443 和 `/certs` 都可以不要。

这也决定了下面三选一里该选哪个：内网访问方式是 `https://域名`，就只能选 **C（内网 DNS）**。A 会把命令里的地址换成 `http://IP:端口`，B 会直接 302 跳到 `http://IP`，两个都是"丢掉 https、丢掉域名"的降级方案。

## 证书自动续期

`/certs` 里的证书 90 天到期。到期没换，公网看着一切正常（那是 Cloudflare 边缘的证书），但**内网用 `https://域名` 会当天开始报错**——那一跳的证书就是容器里这一份。所以「挂 `/certs`」和「配自动续期」是同一件事的两半，只做前半等于埋了个 90 天后的定时炸弹。

### 证书是你自己签的，镜像里一份都不带

这一点先说清楚，免得以为镜像里藏了证书：

- `/certs` 初始就是**空目录**，镜像不带证书、不带私钥、不带任何人的域名
- `/acme` 也只是一个**空目录**，专门用来放验证文件；谁签证书就往里写，跟别人毫无关系
- 本文里的 `komari.example.com`、`192.0.2.10`、`you@example.com` 全是占位符，换成你自己的域名、自己的 IP、自己的邮箱
- 每个人签自己的：你的域名只认你的验证文件，别人的 `/acme` 和 `/certs` 在别人的机器上，两边互不可见、互不影响

### 首次签发的顺序（反了会把面板搞挂）

镜像启动时 `/certs` 是空的，而 `listen 443 ssl` 一加载就要读证书文件。所以顺序必须是「先能跑 → 再签 → 再开 443」：

1. 先起容器，`nginx.conf` 里**只有 http 那段**（80 或 25774），不要写 `listen 443 ssl`
2. 按下面的方式一或方式二签发，把 `fullchain.pem` / `privkey.pem` 落进 `./certs`
3. 再把 443 段加进 `nginx.conf`，`docker exec komari nginx -s reload`（已挂载 conf，reload 就生效，不用重启容器）
4. `curl -I https://你的域名` 返回 200 就完成了

反过来先写 443、`/certs` 还空着：`nginx -t` 报找不到 pem → nginx 起不来 → 整个面板打不开，看起来像是镜像坏了，其实只是证书没到位。

### 两种续期方式，先确认自己属于哪一种

| 续期方式 | CA 怎么验你 | `/acme` | 需要 80 端口被外面访问到 |
|---|---|---|---|
| HTTP-01（`--webroot`） | 抓 `http://域名/.well-known/acme-challenge/<token>` | **必须挂** | 需要 |
| DNS-01（Cloudflare API Token） | 在 CF 加一条 `_acme-challenge` TXT | 不需要 | 不需要 |

域名挂在 Cloudflare 上**不影响** HTTP-01：CF 默认把 `/.well-known/acme-challenge/` 原样透传到源站，不改写也不拦。一条命令就能确认（换成你的域名）：

```bash
curl -i http://komari.example.com/.well-known/acme-challenge/probe
```

- 返回 nginx 的 `404`：请求已经到源站，只是文件不存在 —— **这条路是通的**
- 返回 CF 的 301/403 页面，或者连不上：CF 那边挡了，改用 DNS-01

### 方式一：DNS-01（不依赖 80 端口，推荐）

不需要 `/acme`，也不需要和 CA 建立任何入站连接，只要一个能改 CF DNS 的 Token（权限 `Zone → DNS → Edit`，范围限定到这一个 zone）。

```bash
curl https://get.acme.sh | sh -s email=you@example.com

export CF_Token="你的 Cloudflare API Token"
export CF_Account_ID="你的 Account ID"        # 用 Zone 级 Token 时可留空

~/.acme.sh/acme.sh --issue --dns dns_cf -d komari.example.com \
  --key-file       /你的路径/certs/privkey.pem \
  --fullchain-file /你的路径/certs/fullchain.pem \
  --reloadcmd      "docker exec komari nginx -s reload"
```

`acme.sh` 安装时自己写好 cron，之后每 60 天换一次证书并执行 `--reloadcmd`，nginx 当场 reload，不用重建容器。证书直接落在 `./certs`，公网方向完全不受影响。

### 方式二：HTTP-01 webroot（要挂 `/acme` 的那种）

三样东西必须同时成立，缺一样都会静默失败：

1. compose 挂上。宿主机上的客户端往外写文件时，容器侧 `:ro` 就够；**如果续期跑在另一个容器里，两个目录都要 rw**：
   ```yaml
         - ./acme:/acme:ro
         - ./certs:/certs:ro
   ```
2. **80 和 443 的 server 块里都要**有这段（LE 可能跟着 80 上的跳转去 443 取挑战文件）：
   ```nginx
       location /.well-known/acme-challenge/ {
           root /acme;
       }
   ```
3. 这段 `location` 要放在 302 之前——就算开了 B（`KOMARI_LAN_AUTO`）也不会把挑战请求跳走，因为跳转只对 `Accept: text/html` 的请求生效，CA 抓文件时带的是 `*/*`。这条只是提醒你别把它写进别的 `location` 里面去。

签发，并让证书落到 `./certs`：

```bash
certbot certonly --webroot -w /你的路径/acme -d komari.example.com \
  --deploy-hook "cp /etc/letsencrypt/live/komari.example.com/fullchain.pem /你的路径/certs/ && cp /etc/letsencrypt/live/komari.example.com/privkey.pem /你的路径/certs/ && chmod 600 /你的路径/certs/privkey.pem && docker exec komari nginx -s reload"
```

`--deploy-hook` 会被写进续期配置，之后 `certbot renew` 自动执行它，所以只要一条 cron：

```bash
0 3 * * * certbot renew --quiet
```

### 方式二 · 附：不想在宿主机上装东西，就用容器跑

宿主机上一件东西都不用装，续期也全靠容器自己循环。第一步先签：

```bash
docker run --rm \
  -v $PWD/acme:/acme -v $PWD/certs:/certs -v $PWD/acme-sh:/acme.sh \
  neilpang/acme.sh --issue -w /acme -d komari.example.com --server letsencrypt \
  --key-file /certs/privkey.pem --fullchain-file /certs/fullchain.pem
```

签完 `reload` 一次（`docker exec komari nginx -s reload`），之后把它交给下面这个常驻容器：

```yaml
services:
  acme:
    image: neilpang/acme.sh:latest
    container_name: acme-renew
    restart: always
    entrypoint: ["sh", "-c"]
    command:
      - |
        apk add --no-cache docker-cli >/dev/null 2>&1
        while true; do
          echo "[cron] $(date -Iseconds)"
          acme.sh --cron 2>&1 | tail -4
          docker exec komari nginx -s reload || echo "[warn] reload failed"
          sleep 86400
        done
    volumes:
      - ./acme:/acme
      - ./certs:/certs
      - ./acme-sh:/acme.sh
      - /var/run/docker.sock:/var/run/docker.sock
```

三个关键点，缺一个就不成立：

- **`./acme-sh` 必须挂在容器的 `/acme.sh`**（这是它默认的配置目录）。挂在别的路径上、再用 `--home` 指定，会触发它的自升级逻辑去找一个不存在的文件，然后中途退出，cron 一次都跑不完。
- **`./certs`、`./acme` 要 rw**：这个容器自己负责写文件和装证书，不能 `:ro`。
- **`/var/run/docker.sock` 是给 `docker exec ... nginx -s reload` 用的**。Cert 续完必须 reload，否则 nginx 还拿着内存里的旧证书。代价是**这个容器等价于拥有宿主机 root**，只用自己签出来的镜像，别换成来路不明的。

首次签发时用的是容器内的 `/certs/...` 路径，acme.sh 会把目标路径记进配置，之后每次 `--cron` 都按这个路径重装 —— 所以两边 bind 的目标路径必须写成一样的，别一边 `/certs` 一边改别的名字。

### 验证续期是真的会跑

别等 90 天。签发完立刻空跑一次，能过才算配好：

```bash
certbot renew --dry-run                                        # webroot 方式
~/.acme.sh/acme.sh --renew -d komari.example.com --force        # DNS-01 方式
```

再确认容器里确实换成了新证书：

```bash
docker exec komari nginx -t
echo | openssl s_client -connect 192.0.2.10:443 -servername komari.example.com 2>/dev/null | openssl x509 -noout -dates
```

`notAfter` 已经是新日期就对了。到期前 30 天还没变，说明续期挂了——盯这一条就够，不用翻日志。

### 机器上已经装过客户端的话，先确认它指向这里

不用重装，先看三件事对不对（`certbot` 和 `acme.sh` 各一套，跑你有的那个）：

```bash
# certbot
sudo certbot certificates
sudo grep -E 'webroot_path|authenticator|renew_hook' /etc/letsencrypt/renewal/*.conf
sudo crontab -l 2>/dev/null | grep -i certbot; systemctl list-timers --all | grep -i certbot

# acme.sh
~/.acme.sh/acme.sh --list
grep -E 'Le_Webroot|Le_RealFullChainPath|Le_ReloadCmd' ~/.acme.sh/*/*.conf
crontab -l | grep acme
```

对照这三条：

| 要看什么 | 对的形态 | 不对会怎样 |
|---|---|---|
| `webroot_path` / `Le_Webroot` | **宿主机上** `.../komari/acme`，也就是容器 `/acme` 的那个源目录 | 挑战文件写到别处，CA 抓不到，续期失败 |
| `renew_hook` / `Le_ReloadCmd` | 里有 `docker exec komari nginx -s reload` | 证书换了、nginx 还在用内存里的旧证书，**到期照崩** |
| cron / systemd timer | 存在且没被注释 | 没有触发，90 天后原地过期 |

三条都对，再跑一次 `--dry-run`。只看到“续期成功”不算数——那只证明 CA 给了证书，不证明文件进了容器、更不证明 nginx 换上了。

## 局域网访问不绕 Cloudflare

面板生成的安装命令，用的是「你在浏览器里访问的那个地址」。所以内网设备如果用域名打开面板，复制出来的命令就是域名 —— 内网机器装 agent 时会先出公网、绕一圈 Cloudflare 再回来，慢且容易失败。

镜像提供三种解法，**任选一种**，都默认关闭：

| 做法 | 要打开什么 | 效果 | 适合 |
|---|---|---|---|
| A. 面板里给一个勾选框 | `KOMARI_LAN_TOGGLE=1` | 手动切换，看得见状态 | 内网、公网机器都要装 |
| B. 自动跳转 | `KOMARI_LAN_AUTO=1` | 内网用域名打开会自动跳到 `http://容器IP` | 只在局域网用面板 |
| C. 内网 DNS 加一条本地记录 | 不用镜像参与 | 域名始终是域名，内网直接连容器，https 不变 | 内网也用 `https://域名` 打开 |

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
