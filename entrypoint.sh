#!/bin/sh
# 用 supervisord 把 komari / nginx / cloudflared 三个进程一起拉起来
set -e
exec /usr/bin/supervisord -c /etc/supervisord.conf
