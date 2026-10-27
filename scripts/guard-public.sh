#!/bin/sh
# 公开库泄漏自检。
#
# 这个仓库是公开的，镜像也是公开的（镜像内容只来自仓库里的文件），
# 所以任何真实地址 / 凭据只要进了一次提交，就等于公开了——即使后面
# 再删掉，git 历史里还在。这个脚本就是提交前的那道闸。
#
# 用法：
#   sh scripts/guard-public.sh          # 本地随时跑
#   CI 的 check job 第一步会自动跑它
#
# 只检查「被 git 跟踪的文件」，node_modules 这类本来就不进仓库的东西不管。
# 判定原则：白名单之外的 IPv4、任何 token/私钥形态、任何非占位符密码，一律拦下。
set -u

# 允许出现的地址（文档占位 + 回环 + CI 测试值 + 公共 DNS）：
#   192.0.2.0/24 198.51.100.0/24 203.0.113.0/24  RFC 5737 文档专用段
#   127.0.0.0/8   回环
#   10.9.9.9      CI 里冒充内网地址的测试值
#   0.0.0.0       监听占位
#   223.5.5.5 / 1.1.1.1 / 8.8.8.8  文档里举例用的公共 DNS
ALLOW_IP='^(192\.0\.2\.[0-9]{1,3}|198\.51\.100\.[0-9]{1,3}|203\.0\.113\.[0-9]{1,3}|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|10\.9\.9\.9|0\.0\.0\.0|223\.5\.5\.5|1\.1\.1\.1|8\.8\.8\.8)$'

if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "[guard] 不在 git 仓库里，跳过"
    exit 0
fi
files=$(git ls-files)
if [ -z "$files" ]; then
    echo "[guard] 没有跟踪的文件，跳过"
    exit 0
fi

fail=0
scan() {  # scan <正则>  -> 输出 "文件:行号:内容"
    printf '%s\n' "$files" | tr '\n' '\0' \
        | xargs -0 grep -InE -- "$1" 2>/dev/null || true
}

echo "[guard] 检查 $(printf '%s\n' "$files" | wc -l) 个被跟踪的文件"

# 1) 真实 IP：白名单之外的 IPv4 全部算泄漏（内网地址、公网服务器地址）
bad_ip=$(printf '%s\n' "$files" | tr '\n' '\0' \
    | xargs -0 grep -hoE '([0-9]{1,3}\.){3}[0-9]{1,3}' 2>/dev/null \
    | sort -u | grep -vE "$ALLOW_IP" || true)
if [ -n "$bad_ip" ]; then
    echo "[guard] 发现不在白名单里的 IP（部署地址不能进公开库）："
    printf '%s\n' "$bad_ip" | sed 's/^/    /'
    echo "        确认是文档示例就加到脚本顶部的 ALLOW_IP"
    fail=1
fi

# 2) 凭据：GitHub token、Cloudflare 隧道 token、私钥
bad_cred=$(scan 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{40,}|BEGIN [A-Z ]*PRIVATE KEY')
if [ -n "$bad_cred" ]; then
    echo "[guard] 发现 token / 私钥："
    printf '%s\n' "$bad_cred" | sed 's/^/    /'
    fail=1
fi

# 3) 硬编码密码：放行占位符、GitHub secrets 引用、环境变量透传
bad_pwd=$(scan '(PASSWORD|SECRET|_TOKEN)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9._/+@-]{6,}' \
    | grep -vE 'test-only|\$\{\{|ENV_|换成|your|CHANGE|0{16,}|placeholder' || true)
if [ -n "$bad_pwd" ]; then
    echo "[guard] 发现疑似硬编码密码："
    printf '%s\n' "$bad_pwd" | sed 's/^/    /'
    fail=1
fi

if [ "$fail" = "1" ]; then
    echo "[guard] 未通过：先把上面这些换成占位符再提交"
    exit 1
fi
echo "[guard] 通过：没有真实地址 / 凭据 / 密码"
