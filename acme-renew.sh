#!/bin/sh
# 镜像内置的证书签发 / 续期。
#
# 为什么不再单独跑一个 acme 容器：nginx 本来就在这个镜像里，renew 之后
# 只需要 `nginx -s reload` 一下。同容器直接 reload 就行，不必再挂
# docker.sock、也不必 `docker exec`——少一个容器、少一个 root 等价权限。
#
# 开法：什么都不用配。域名会按下面的顺序自动识别：
#   1. KOMARI_ACME_DOMAIN（想固定某个域名才填，可选）
#   2. /certs 里现有证书的 CN（续期、重启都认得出，不依赖任何外部信息）
#   3. cloudflared 日志里的远端隧道配置（CF 后台配的 hostname，全新部署靠它）
# 不想签就设 KOMARI_ACME_ENABLED=0。
#
# 其余可选：KOMARI_ACME_EMAIL / KOMARI_ACME_SERVER / KOMARI_ACME_STAGING
#          KOMARI_ACME_WEBROOT(默认 /acme) / KOMARI_ACME_CERTS(默认 /certs)
#          KOMARI_ACME_INTERVAL(默认 86400 秒) / KOMARI_CFD_LOG(默认 /var/log/cloudflared.log)
set -u

log() { printf '[acme] %s\n' "$*"; }

ENABLED="${KOMARI_ACME_ENABLED:-auto}"
DOMAIN="${KOMARI_ACME_DOMAIN:-}"
ACME_HOME="${KOMARI_ACME_HOME:-/acme.sh}"
WEBROOT="${KOMARI_ACME_WEBROOT:-/acme}"
CERT_DIR="${KOMARI_ACME_CERTS:-/certs}"
EMAIL="${KOMARI_ACME_EMAIL:-}"
SERVER="${KOMARI_ACME_SERVER:-letsencrypt}"
INTERVAL="${KOMARI_ACME_INTERVAL:-86400}"
SEED_DIR=/opt/acme-seed
CF_LOG="${KOMARI_CFD_LOG:-/var/log/cloudflared.log}"

# nginx 用绝对路径，reloadcmd 被 acme.sh 记进配置后是以它自己的环境执行的
if [ -x /usr/sbin/nginx ]; then NGINX=/usr/sbin/nginx; else NGINX=nginx; fi

# 已有证书的 CN —— 续期/重启场景最稳，连不上外网也认得出
domain_from_cert() {
    [ -f "$CERT_DIR/fullchain.pem" ] || return 1
    command -v openssl >/dev/null 2>&1 || return 1
    d=$(openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject 2>/dev/null \
        | sed -n 's/.*CN[[:space:]]*=[[:space:]]*\([^,/]*\).*/\1/p' | head -n 1 | tr -d ' ')
    case "$d" in
        ""|localhost|komari.local|\*.local) return 1 ;;
    esac
    printf '%s\n' "$d"
}

# cloudflared 连上后会把远端配置整行打出来：
#   INF Updated to new configuration config="{\"ingress\":[{\"hostname\":\"panel.example.com\", ...
# 日志里的引号是转义的，先还原成正常引号再抓 hostname；通配符（*.example.com）签不了 HTTP-01，跳过。
domain_from_cf() {
    [ -f "$CF_LOG" ] || return 1
    h=$(sed 's/\\"/"/g' "$CF_LOG" 2>/dev/null | tr -d '\n' \
        | grep -o '"hostname":"[A-Za-z0-9._*-]*"' 2>/dev/null \
        | sed 's/^.*:"//; s/"$//' \
        | while read -r x; do
            case "$x" in ""|localhost|\*.*) continue ;; esac
            printf '%s\n' "$x"
            break
        done)
    [ -n "$h" ] || return 1
    printf '%s\n' "$h"
}

# 起容器时 cloudflared 还没连上，日志要等几秒；最多等 90 秒
resolve_domain() {
    [ -n "$DOMAIN" ] && return 0
    i=0
    while [ "$i" -lt 45 ]; do
        d=$(domain_from_cert 2>/dev/null || true)
        if [ -n "$d" ]; then DOMAIN="$d"; SRC="已有证书 CN"; return 0; fi
        d=$(domain_from_cf 2>/dev/null || true)
        if [ -n "$d" ]; then DOMAIN="$d"; SRC="CF 隧道配置"; return 0; fi
        i=$((i + 1))
        sleep 2
    done
    return 1
}

# 排障用：docker exec komari acme-renew.sh --resolve-only
if [ "${1:-}" = "--resolve-only" ]; then
    if resolve_domain; then
        log "识别到域名：$DOMAIN（来源：${SRC:-KOMARI_ACME_DOMAIN}）"
        exit 0
    fi
    log "没识别到域名：$CERT_DIR 里没有证书，$CF_LOG 里也没有 hostname"
    exit 1
fi

if [ "$ENABLED" = "0" ] || [ "$ENABLED" = "false" ]; then
    log "未启用（KOMARI_ACME_ENABLED=0），本次不签发"
    exit 0
fi

if ! resolve_domain; then
    log "没识别到域名：$CERT_DIR 里没有证书，$CF_LOG 里也没有 hostname；本次不签发"
    exit 0
fi
log "域名：$DOMAIN（来源：${SRC:-KOMARI_ACME_DOMAIN}）"

# auto：nginx 确实引用这个证书目录才值得去签，否则只是在浪费 ACME 配额
if [ "$ENABLED" = "auto" ] || [ -z "$ENABLED" ]; then
    refs=0
    for f in /etc/nginx/http.d/*.conf /etc/nginx/conf.d/*.conf; do
        [ -f "$f" ] || continue
        if grep -q -- "$CERT_DIR" "$f" 2>/dev/null; then refs=1; break; fi
    done
    if [ "$refs" != "1" ]; then
        log "nginx 没有引用 $CERT_DIR，跳过签发（要强开就设 KOMARI_ACME_ENABLED=1）"
        exit 0
    fi
fi

# 白名单，防止把奇怪的值塞进 --server
case "$SERVER" in
    letsencrypt|letsencrypt_test|zerossl|buypass|buypass_test|google|google_test) ;;
    *) log "未知的 KOMARI_ACME_SERVER=$SERVER，回退 letsencrypt"; SERVER=letsencrypt ;;
esac
if [ "${KOMARI_ACME_STAGING:-0}" = "1" ]; then
    case "$SERVER" in
        letsencrypt*) SERVER=letsencrypt_test ;;
        buypass*)     SERVER=buypass_test ;;
        google*)      SERVER=google_test ;;
    esac
    log "已切换测试环境（$SERVER）：签出来的证书浏览器不认，只用来验证流程"
fi

mkdir -p "$ACME_HOME" "$WEBROOT" "$CERT_DIR" 2>/dev/null || true

# acme.sh 的可执行文件放在 working dir 里（和官方镜像一致）。
# 但 /acme.sh 会被用户挂载成宿主机目录，首次挂载时是空的，把镜像里的
# 那份重新铺回去，否则 cron 一次都跑不起来。
if [ ! -x "$ACME_HOME/acme.sh" ] && [ -d "$SEED_DIR" ]; then
    cp -a "$SEED_DIR"/. "$ACME_HOME"/ 2>/dev/null || true
    chmod +x "$ACME_HOME/acme.sh" 2>/dev/null || true
    log "已把内置的 acme.sh 铺到 $ACME_HOME"
fi
ACME_BIN="$ACME_HOME/acme.sh"
if [ ! -x "$ACME_BIN" ]; then
    log "找不到 $ACME_BIN，无法签发，退出"
    exit 1
fi

# 关掉自升级：容器里的脚本随镜像走，不需要它自己去 GitHub 换自己
# （开着的话会在只读/空目录场景下直接报错退出，cron 一次都跑不完整）
if [ -f "$ACME_HOME/account.conf" ]; then
    sed -i "s/AUTO_UPGRADE='1'/AUTO_UPGRADE='0'/" "$ACME_HOME/account.conf" 2>/dev/null || true
    grep -q "AUTO_UPGRADE" "$ACME_HOME/account.conf" 2>/dev/null || echo "AUTO_UPGRADE='0'" >> "$ACME_HOME/account.conf"
else
    printf "AUTO_UPGRADE='0'\n" > "$ACME_HOME/account.conf"
fi

reload_nginx() {
    if ! "$NGINX" -t >/dev/null 2>&1; then
        log "nginx -t 没通过（可能是配置还没就绪），这次先不 reload"
        return 0
    fi
    if "$NGINX" -s reload >/dev/null 2>&1; then
        log "nginx 已 reload，新证书生效"
    else
        log "nginx reload 失败，检查 nginx 是否在跑"
    fi
}

issue() {
    log "首次签发 $DOMAIN（webroot=$WEBROOT，server=$SERVER）"
    set -- --issue -d "$DOMAIN" -w "$WEBROOT" --server "$SERVER"
    [ -n "$EMAIL" ] && set -- "$@" --accountemail "$EMAIL"
    "$ACME_BIN" "$@"
}

install_cert() {
    "$ACME_BIN" --install-cert -d "$DOMAIN" \
        --key-file "$CERT_DIR/privkey.pem" \
        --fullchain-file "$CERT_DIR/fullchain.pem" \
        --reloadcmd "$NGINX -s reload"
}

log "已启用：域名=$DOMAIN server=$SERVER webroot=$WEBROOT 证书目录=$CERT_DIR 检查间隔=${INTERVAL}s"

while true; do
    # acme.sh 自己的记录才代表「签过」——/certs 里可能是你之前手工放进去的
    if [ ! -f "$ACME_HOME/$DOMAIN/$DOMAIN.conf" ]; then
        if issue; then
            install_cert
            reload_nginx
            log "签发完成，$CERT_DIR/fullchain.pem 已就位"
        else
            log "签发失败，10 分钟后重试（确认域名已解析到本容器、且 $WEBROOT 能被 nginx 从 /.well-known/acme-challenge/ 读出来）"
            sleep 600
            continue
        fi
    else
        log "检查续期"
        "$ACME_BIN" --cron 2>&1 | tail -n 6 || log "acme.sh --cron 返回非 0"
        # 到期前 30 天内才会真的换证书；没到期时 reload 也无害
        reload_nginx
    fi
    sleep "$INTERVAL"
done
