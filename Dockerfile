# 单一镜像：komari + nginx + cloudflared + acme.sh（证书签发/续期）由 supervisord 一起管
# 用官方 cloudflared 镜像的二进制作多阶段来源，避免构建时 curl 下载 / 手动判架构
FROM cloudflare/cloudflared:latest AS cloudflared

FROM ghcr.io/komari-monitor/komari:latest

# 基础镜像已是 alpine：nginx 反代、supervisor 管进程、openssl 给 acme.sh 和占位证书用
RUN apk add --no-cache nginx supervisor tzdata ca-certificates curl openssl

# 从官方镜像拷 cloudflared 二进制（自动匹配 amd64/arm64）
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

# ── acme.sh：证书签发 + 续期，就在本镜像里跑 ──────────────────────────────
# 不再需要单独的 acme 容器，也不需要 docker.sock：续期完直接在本容器
# `nginx -s reload`。二进制同时放一份进 /opt/acme-seed，因为 /acme.sh 会被
# 挂载成宿主机目录（首次挂载是空的），启动时要把这份铺回去。
RUN set -eux; \
    curl -fsSL --retry 3 --retry-delay 2 \
        https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh \
        -o /usr/local/bin/acme.sh; \
    chmod +x /usr/local/bin/acme.sh; \
    mkdir -p /acme.sh; \
    cp /usr/local/bin/acme.sh /acme.sh/acme.sh; \
    chmod +x /acme.sh/acme.sh; \
    printf "AUTO_UPGRADE='0'\n" > /acme.sh/account.conf; \
    mkdir -p /opt/acme-seed; \
    cp -a /acme.sh/. /opt/acme-seed/; \
    acme.sh --version 2>/dev/null | head -2 || true

COPY supervisord.conf /etc/supervisord.conf
COPY entrypoint.sh /entrypoint.sh
COPY acme-renew.sh /usr/local/bin/acme-renew.sh
COPY lan-toggle.js /usr/local/share/wb/lan-toggle.js
RUN chmod +x /entrypoint.sh /usr/local/bin/acme-renew.sh

EXPOSE 25775 80 443

ENV KOMARI_LISTEN=127.0.0.1:25775

ENTRYPOINT ["/entrypoint.sh"]
