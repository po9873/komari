# 单一镜像：komari + nginx + cloudflared，三个进程由 supervisord 管
# 用官方 cloudflared 镜像的二进制作多阶段来源，避免构建时 curl 下载 / 手动判架构
FROM cloudflare/cloudflared:latest AS cloudflared

FROM ghcr.io/komari-monitor/komari:latest

# 基础镜像已是 alpine，装 nginx + supervisor
RUN apk add --no-cache nginx supervisor tzdata ca-certificates

# 从官方镜像拷 cloudflared 二进制（自动匹配 amd64/arm64）
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

COPY supervisord.conf /etc/supervisord.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 25775 80 443

ENV KOMARI_LISTEN=127.0.0.1:25775

ENTRYPOINT ["/entrypoint.sh"]
