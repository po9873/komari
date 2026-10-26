# komari（all-in-one）

把 komari + nginx + cloudflared 三个进程打进**一个镜像**，由 supervisord 启动。
仓库只做“打包”——网络、IP/MAC、密码、Token 全部由你自己的运行环境提供。

## 文件
- `Dockerfile` — 基于官方 komari 镜像，装入 nginx / cloudflared / supervisor
- `supervisord.conf` — 同时拉起 komari / nginx / cloudflared
- `entrypoint.sh` — 启动 supervisord
- `.github/workflows/build.yml` — push 自动构建；定时检查上游（komari / cloudflared），有新版本才构建，没更新直接跳过

## 构建 / 运行
- push 到 main 自动构建，同时推到两个仓库：
  - Docker Hub：`docker.io/<你的DockerHub用户名>/komari:latest`
  - GHCR：`ghcr.io/<你>/komari:latest`
- 要用 Docker Hub，需在仓库 **Settings → Secrets and variables → Actions** 里加两个 secret：
  - `DOCKERHUB_USERNAME` — Docker Hub 用户名
  - `DOCKERHUB_TOKEN` — Docker Hub 的 Access Token（hub.docker.com → Account settings → Security → New Access Token，权限给 Read & Write）
  - 未配置这两个 secret 时，构建会直接失败并提示，避免误以为推送成功。
- 本地构建：`docker build -t komari .`
- 运行：跟原来三个容器时一样，把这个镜像替换掉那三个容器即可；网络、IP/MAC、`ADMIN_*`、`TUNNEL_TOKEN`、挂载目录都按你本机原样传。

容器内：komari 只听 `127.0.0.1:25775`，nginx 反代它并负责 80/443，cloudflared 走隧道。
三者共享回环，所以原来的 `komari.conf`（`proxy_pass 127.0.0.1:25775`）和 Cloudflare ingress
（`localhost:25775`）都不用改。
