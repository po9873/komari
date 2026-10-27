#!/bin/sh
# 用 supervisord 把 komari / nginx / cloudflared 三个进程一起拉起来
set -e

LAN_CONF=/etc/nginx/http.d/00-lan.conf
TOGGLE_JS=/usr/local/share/wb/lan-toggle.js

# 两种模式都没开时也要写一份，保证挂载的 default.conf 里
# if ($wb_redirect_lan) 不会因为变量未定义而让 nginx 起不来
lan_disabled() {
    cat > "$LAN_CONF" <<'EOF'
# 内网相关功能均未启用（KOMARI_LAN_TOGGLE / KOMARI_LAN_AUTO 都不是 1）
map $host $wb_redirect_lan { default 0; }
map $host $wb_lan_authority { default ""; }
EOF
}

# 容器自己的内网地址：启动时探测，镜像里不写死任何 IP
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

if [ "${KOMARI_LAN_TOGGLE:-0}" = "1" ]; then
    # ── 模式一：面板「一键部署指令」页里给一个勾选框，安装命令改用当前访问地址
    # 注意：地址不再写死容器 IP，而是用浏览器里的 window.location.host（用户当前打开面板用的地址），
    #       所以这里不再依赖容器 IPv4 探测，任何能跑起来的环境都能开。
    payload=$(base64 < "$TOGGLE_JS" | tr -d '\n')

    # nginx 单个 token 有 4KB 上限，脚本要切块放进 map，再拼成一个变量用
    cat > "$LAN_CONF" <<'EOF'
# 由 entrypoint 生成：往「一键部署指令」页注入地址切换勾选框
# 脚本内容切成小块放在 map 里（nginx 单个参数不能超过 4KB），最后拼成 $wb_inject
# 地址不写死：前端用 window.location.host（当前访问地址），镜像到谁手里都是谁自己的地址
map $host $wb_redirect_lan { default 0; }
map $host $wb_lan_authority { default ""; }

EOF
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
sub_filter '</body>' '<script>(function(){try{var b="\$wb_inject";var c=new TextDecoder().decode(Uint8Array.from(atob(b),function(k){return k.charCodeAt(0)}));var s=document.createElement("script");s.textContent=c;document.body.appendChild(s);}catch(e){}})();</script></body>';
# 上游如果 gzip，sub_filter 改不了，这里统一要明文
proxy_set_header Accept-Encoding "";
EOF
    echo "[entrypoint] 内网地址勾选框已启用（脚本 ${idx} 块，使用当前访问地址，不写死 IP）"
elif [ "${KOMARI_LAN_AUTO:-0}" = "1" ]; then
    # ── 模式二：不带勾选框，内网用域名访问时直接 302 到容器地址
    detect_host

    # 默认跟着 nginx 实际监听的端口（macvlan 直连时就是它，不用配）
    lan_port="${KOMARI_LAN_PORT:-}"

    if [ -z "$lan_host" ]; then
        echo "[entrypoint] KOMARI_LAN_AUTO=1 但没探测到容器的 IPv4，内网跳转已跳过" >&2
        lan_disabled
    else
        if [ -z "$lan_port" ]; then
            lan_authority="$lan_host:\$server_port"
        elif [ "$lan_port" = "80" ]; then
            lan_authority="$lan_host"
        else
            lan_authority="$lan_host:$lan_port"
        fi

        cat > "$LAN_CONF" <<EOF
# 由 entrypoint 生成：容器自身的内网地址
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
    fi
else
    lan_disabled
fi

exec /usr/bin/supervisord -c /etc/supervisord.conf
