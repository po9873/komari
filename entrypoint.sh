#!/bin/sh
# 用 supervisord 把 komari / nginx / cloudflared 三个进程一起拉起来
set -e

LAN_CONF=/etc/nginx/http.d/00-lan.conf
TOGGLE_JS=/usr/local/share/wb/lan-toggle.js

# 容器自身的内网地址：启动时探测，镜像里不写死任何 IP（仅供可选的 302 跳转用）
detect_host() {
    lan_host="${KOMARI_LAN_HOST:-auto}"
    if [ "$lan_host" = "auto" ] || [ -z "$lan_host" ]; then
        lan_host=$(ip -4 addr show 2>/dev/null \
            | awk '/inet /{a=$2; sub(/\/.*/,"",a); if (a != "" && a !~ /^127\./) {print a; exit}}')
    fi
    if [ -z "$lan_host" ] && command -v hostname >/dev/null 2>&1; then
        lan_host=$(hostname -i 2>/dev/null | awk '{print $1}')
        [ "$lan_host" = "127.0.1.1" ] && lan_host=""
    fi
}

# 内网明文端口：从挂进来的 nginx 配置里自己找，不用在 stack 里填。
# 规则：跳过带 ssl 的（443）；剩下的有「非 80 的明文口」就用它，否则用 80。
detect_lan_port() {
    lan_port=""
    for f in /etc/nginx/http.d/*.conf /etc/nginx/conf.d/*.conf; do
        [ -f "$f" ] || continue
        for p in $(awk '
            /^[ \t]*#/ { next }
            /^[ \t]*listen[ \t]/ {
                line = $0
                if (line ~ /ssl/) next
                sub(/^[ \t]*listen[ \t]+/, "", line)
                gsub(/[][]/, "", line)
                n = split(line, a, "[: ;]+")
                for (i = 1; i <= n; i++)
                    if (a[i] ~ /^[0-9]+$/) { print a[i]; break }
            }' "$f" 2>/dev/null); do
            [ "$p" = "443" ] && continue
            if [ "$p" != "80" ]; then
                lan_port="$p"
                return 0
            fi
            lan_port="80"
        done
    done
    [ -n "$lan_port" ] || lan_port="80"
}

# 始终注入「安装命令自动改用当前访问地址」脚本（无 UI，不写死 IP）
# 这个脚本不渲染任何控件，只在前端把安装命令里的面板地址换成 location.origin。
# KOMARI_LAN_INJECT=0 可关掉（关掉后命令永远是面板默认的地址）。
setup_lan_script() {
    if [ "${KOMARI_LAN_INJECT:-1}" = "0" ] || [ ! -f "$TOGGLE_JS" ]; then
        cat > "$LAN_CONF" <<'EOF'
map $host $wb_redirect_lan { default 0; }
map $host $wb_lan_authority { default ""; }
EOF
        echo "[entrypoint] 安装命令自动改写已关闭（KOMARI_LAN_INJECT=0）"
        return
    fi
    payload=$(base64 < "$TOGGLE_JS" | tr -d '\n')
    cat > "$LAN_CONF" <<'EOF'
# 镜像内置：安装命令自动改用当前访问地址（无 UI、不暴露内网 IP）
map $host $wb_redirect_lan { default 0; }
map $host $wb_lan_authority { default ""; }
EOF
    # 勾选框模式（默认开，KOMARI_LAN_TOGGLE=0 关掉）：把内网地址传给前端。
    # 内网地址 = 启动时探测的容器 IP + 从 nginx 配置里识别到的明文端口——
    # 两家部署各不相同，镜像里零写死、stack 里也不用填。
    if [ "${KOMARI_LAN_TOGGLE:-1}" = "1" ]; then
        detect_host
        dbg_flag=""
        [ "${KOMARI_LAN_DEBUG:-0}" = "1" ] && dbg_flag='\"debug\":1,'
        # 默认勾上（内网/域名打开都一样）；KOMARI_LAN_DEFAULT=0 改成默认用域名
        chk_flag=""
        [ "${KOMARI_LAN_DEFAULT:-1}" = "0" ] && chk_flag='\"checked\":0,'
        if [ -n "$lan_host" ]; then
            if [ -n "${KOMARI_LAN_PORT:-}" ]; then
                lan_port="$KOMARI_LAN_PORT"
            else
                detect_lan_port
            fi
            lan_scheme="http"
            [ "$lan_port" = "443" ] && lan_scheme="https"
            # 默认端口不写进地址：http 的 80 / https 的 443 都省掉，标签好看也好复制
            if [ "$lan_port" = "80" ] || [ "$lan_port" = "443" ]; then
                lan_addr="$lan_host"
            else
                lan_addr="$lan_host:$lan_port"
            fi
            wb_boot="{$dbg_flag$chk_flag\\\"lanOrigin\\\":\\\"$lan_scheme://$lan_addr\\\",\\\"toggle\\\":1}"
            echo "[entrypoint] 勾选框模式：内网地址 $lan_scheme://$lan_addr"
        else
            wb_boot="{$dbg_flag$chk_flag\\\"toggle\\\":1}"
            echo "[entrypoint] KOMARI_LAN_TOGGLE=1 但没探测到容器 IPv4，勾选框地址回退为当前访问地址" >&2
        fi
    else
        wb_boot="{}"
    fi
    printf 'map $host $wb_boot { default "%s"; }\n' "$wb_boot" >> "$LAN_CONF"
    rest="$payload"
    idx=0
    refs=""
    while [ -n "$rest" ]; do
        part=$(printf '%s' "$rest" | cut -c1-3000)
        rest=$(printf '%s' "$rest" | cut -c3001-)
        idx=$((idx + 1))
        printf 'map $host $wb_inj%s { default "%s"; }\n' "$idx" "$part" >> "$LAN_CONF"
        refs="${refs}\$wb_inj${idx}"
    done

    cat >> "$LAN_CONF" <<EOF
map \$host \$wb_inject { default "$refs"; }

sub_filter_once on;
sub_filter '</body>' '<script>window.__WB_LAN__=\$wb_boot;</script><script>(function(){try{var b="\$wb_inject";var c=new TextDecoder().decode(Uint8Array.from(atob(b),function(k){return k.charCodeAt(0)}));var s=document.createElement("script");s.textContent=c;document.body.appendChild(s);}catch(e){}})();</script></body>';
# 上游如果 gzip，sub_filter 改不了，这里统一要明文
proxy_set_header Accept-Encoding "";
EOF
    if [ "${KOMARI_LAN_TOGGLE:-1}" = "1" ]; then
        echo "[entrypoint] 已注入：勾选框（一键部署指令弹窗的安装选项里）+ 命令自动改写（内网端口 ${lan_port:-未识别}）"
    else
        echo "[entrypoint] 已注入：安装命令按当前访问地址自动改写（无 UI；KOMARI_LAN_TOGGLE=0 关掉了勾选框）"
    fi
}

# 可选增强：内网域名访问时 302 跳转到容器地址（同样无 UI）
# 设 KOMARI_LAN_AUTO=1 开启；不需要就不开。
setup_lan_redirect() {
    if [ "${KOMARI_LAN_AUTO:-0}" != "1" ]; then
        return
    fi
    detect_host
    lan_port="${KOMARI_LAN_PORT:-}"
    if [ -z "$lan_host" ]; then
        echo "[entrypoint] KOMARI_LAN_AUTO=1 但没探测到容器 IPv4，内网跳转已跳过" >&2
        return
    fi
    if [ -z "$lan_port" ]; then
        lan_authority="$lan_host:\$server_port"
    elif [ "$lan_port" = "80" ]; then
        lan_authority="$lan_host"
    else
        lan_authority="$lan_host:$lan_port"
    fi

    cat >> "$LAN_CONF" <<EOF
map \$http_host \$wb_host_is_ip {
    default 0;
    "~^[0-9]{1,3}(\.[0-9]{1,3}){3}(:[0-9]+)?\$" 1;
    "~^\[[0-9a-fA-F:]+\](:[0-9]+)?\$" 1;
}
# 带 CF-Ray / CF-Connecting-IP 说明请求是 Cloudflare 送来的
map "\$http_cf_ray\$http_cf_connecting_ip" \$wb_from_cf {
    default 1;
    ""      0;
}
map \$http_accept \$wb_wants_html {
    default 0;
    "~*text/html" 1;
}
# 只有「没走 Cloudflare + Host 是域名 + 要的是页面」才跳
map "\$wb_from_cf|\$wb_host_is_ip|\$wb_wants_html" \$wb_redirect_lan {
    default 0;
    "0|0|1" 1;
}
map \$host \$wb_lan_authority {
    default "$lan_authority";
}
EOF
    echo "[entrypoint] 内网跳转已启用 -> http://$lan_authority"
}

# /certs 还是空的、但 nginx 已经 `listen 443 ssl` 指着它：先放一张 7 天自签占位证书。
# 否则 nginx 一加载就报找不到 pem，起不来、整个面板打不开——顺序错了看起来像镜像坏了。
# 这时域名可能还没识别出来（cloudflared 日志要连上才打），CN 先占位成 komari.local，
# acme.sh 拿到真域名后直接覆盖这两个文件并 reload。
setup_bootstrap_cert() {
    [ "${KOMARI_ACME_ENABLED:-auto}" = "0" ] && return 0
    crt_dir="${KOMARI_ACME_CERTS:-/certs}"
    [ -f "$crt_dir/fullchain.pem" ] && return 0
    # nginx 没引用这个目录就没什么好占位的
    refs=0
    for f in /etc/nginx/http.d/*.conf /etc/nginx/conf.d/*.conf; do
        [ -f "$f" ] || continue
        if grep -q -- "$crt_dir" "$f" 2>/dev/null; then refs=1; break; fi
    done
    [ "$refs" = "1" ] || return 0
    mkdir -p "$crt_dir" 2>/dev/null || true
    if openssl req -x509 -nodes -newkey rsa:2048 -days 7 \
        -subj "/CN=${KOMARI_ACME_DOMAIN:-komari.local}" \
        -keyout "$crt_dir/privkey.pem" -out "$crt_dir/fullchain.pem" >/dev/null 2>&1; then
        chmod 600 "$crt_dir/privkey.pem" 2>/dev/null || true
        echo "[entrypoint] $crt_dir 是空的，先放了张 7 天自签占位证书，等 acme.sh 换正式证书"
    else
        echo "[entrypoint] 占位证书没生成出来（$crt_dir 可写吗？）" >&2
    fi
}

setup_bootstrap_cert
setup_lan_script
setup_lan_redirect

if [ "${KOMARI_ACME_ENABLED:-auto}" = "0" ]; then
    echo "[entrypoint] 内置 ACME 已关闭（KOMARI_ACME_ENABLED=0）：不签证书、不动 ${KOMARI_ACME_CERTS:-/certs}"
else
    echo "[entrypoint] 内置 ACME 待命：域名从 ${KOMARI_ACME_DOMAIN:-「/certs 已有证书 / CF 隧道配置」自动识别} -> ${KOMARI_ACME_CERTS:-/certs}"
fi

exec /usr/bin/supervisord -c /etc/supervisord.conf