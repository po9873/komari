# komari（all-in-one）

komari + nginx + cloudflared 打进一个镜像，supervisord 启动。
仓库只管打包，网络 / IP / MAC / 密码 / Token 都在你自己的运行环境里给。

## 镜像
- `docker.io/<你的DockerHub用户名>/komari:latest`
- `ghcr.io/<你>/komari:latest`（备份）

## 文件
- `Dockerfile` — 官方 komari 镜像 + nginx + cloudflared + supervisor
- `supervisord.conf` — 拉起三个进程
- `entrypoint.sh` — 入口
- `.github/workflows/build.yml` — 每天查上游（komari / cloudflared / nginx），有更新才构建推送；也可手动 Run workflow

## 需要的 Secrets
Settings → Secrets and variables → Actions 里加两个：
- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`（hub.docker.com → Account settings → Security → New Access Token，Read & Write）

## 部署
把原来的三个容器换成一个，IP / MAC / 挂载 / 环境变量照旧。
komari 只听 `127.0.0.1:25775`，所以原来的 `komari.conf` 和 Cloudflare ingress 都不用改。
