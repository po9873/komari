#!/bin/sh
# 镜像内置的证书签发 / 续期。
#
# 为什么不再单独跑一个 acme 容器：nginx 本来就在这个镜像里，renew 之后
# 只需要 `nginx -s reload` 一下。同容器直接 reload 就行，不必再挂
# docker.sock、也不必 `docker exec`——少一个容器、少一个 root 等价权限。
#
# 开法（两个 env 配齐才生效）：
#   KOMARI_ACME_ENABLED=1
#   KOMARI_ACME_DOMAIN=komari.example.com
#
# 其余可选：KOMARI_ACME_EMAIL / KOMARI_ACME_SERVER / KOMARI_ACME_STAGING
#          KOMARI_ACME_WEBROOT(默认 /acme) / KOMARI_ACME_CERTS(默认 /certs)
#          KOMARI_ACME_INTERVAL(默认 86400 秒)
set -u

log() { printf '[acme] %s\n' "$*"; }

ENABLED="${KOMARI_ACME_ENABLED:-0}"
DOMAIN="${KOMARI_ACME_DOMAIN:-}"
ACME_HOME="${KOMARI_ACME_HOME:-/acme.sh}"
WEBROOT="${KOMARI_ACME_WEBROOT:-/acme}"
CERT_DIR="${KOMARI_ACME_CERTS:-/certs}"
EMAIL="${KOMARI_ACME_EMAIL:-}"
SERVER="${KOMARI_ACME_SERVER:-letsencrypt}"
INTERVAL="${KOMARI_ACME_INTERVAL:-86400}"
SEED_DIR=/opt/acme-seed

# nginx 用绝对路径，reloadcmd 被 acme.sh 记进配置后是以它自己的环境执行的
if [ -x /usr/sbin/nginx ]; then NGINX=/usr/sbin/nginx; else NGINX=nginx; fi

if [ "$ENABLED" != "1" ]; then
    log "未启用（要 KOMARI_ACME_ENABLED=1 且 KOMARI_ACME_DOMAIN=你的域名），本次不签发"
    exit 0
fi
if [ -z "$DOMAIN" ]; then
    log "KOMARI_ACME_DOMAIN 为空，不签发。设成你的面板域名再重启容器"
    exit 0
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
