# 部署与验证

## 平台

| 运行环境 | 方式 | 验证状态 |
|---|---|---|
| Windows amd64 | Node.js 22+ 原生 | 本地测试通过 |
| Windows Docker Desktop | WSL2/Linux 容器后端 | 已配置，待实际 Docker 构建和启动验证 |
| Linux amd64 | Docker 或 Node.js | GitHub Actions 构建、测试与容器启动通过 |
| 树莓派 arm64（64 位系统） | Docker 或 Node.js | arm64 镜像在 QEMU 下构建、测试与启动通过；树莓派实机待测 |

Docker 目标是 `linux/amd64` 和 `linux/arm64`。Windows Docker Desktop 使用 Linux 容器模式；这不是 Windows 原生容器镜像。32 位树莓派系统不在当前支持范围。

## Windows PowerShell

```powershell
Copy-Item .env.example .env
# 编辑 .env 中的 API_KEY 与 GENAI_TOKEN，或 GENAI_USERNAME / GENAI_PASSWORD
docker compose up -d --build
docker compose logs --tail 100
```

## Linux 与树莓派

```sh
cp .env.example .env
# 编辑 .env
docker compose up -d --build
docker compose logs --tail 100
```

目前 GHCR 尚未发布，因此使用本地构建。发布完成后的目标为 `ghcr.io/blue-flag-666/shtech-webchat2api:latest`，同一个标签应包含两个架构。届时可使用 `docker compose pull` 和 `docker compose up -d --no-build`。

非容器运行：`node --env-file=.env server.mjs`。客户端 Base URL 为 `http://127.0.0.1:8787/v1`。

## 配置与资源

- `API_KEY` 必填，与学校 token 独立。
- `GENAI_TOKEN` 可使用现有网页 JWT；过期后更新。配置 CAS 用户名和密码时，代理在过期前、HTTP 401 或首个 SSE 登录失效事件后重新登录。HTTP/SSE 共用一次重试预算，输出正文后不重试。
- `GENAI_PASSWORD_FILE`、`GENAI_TOKEN_FILE`、`API_KEY_FILE` 可以指向只读 secret 文件。服务不将刷新后的 token 持久化到磁盘。
- 2026-09-13 已真实验证 CAS/OAuth 自动登录取得 token，以及现有网页 token 的非流式和 SSE 聊天。验证码或登录页变更会报错，不会绕过人工验证。`node --env-file=.env verify.mjs --cas` 可强制从账号密码登录后验证聊天。
- Chat 普通流式回复不累计整段正文；Responses/Messages 为组装最终响应保留正文，工具请求也需汇总后解析。单事件上限 1 MiB，累计回复上限 8 MiB。
- 模型目录 5 分钟缓存、共享并发查询，避免重复访问学校接口。只保留明确使用 Xinference 路由的已知国内模型家族，未知路由不猜测为自部署。
- 当前基础镜像仍含 Node 运行时；Windows 合成负载的测量与复测命令见 [RESOURCE_REPORT.md](RESOURCE_REPORT.md)。实际镜像大小和树莓派 RSS 尚未测量，不能保证具体最低资源。
- Compose 只读、非 root、移除 capabilities，并默认只将端口暴露在宿主机回环地址。
- SIGTERM / Ctrl+C 停止接收新请求，允许进行中的请求在 5 秒内完成，超时断开并取消聊天上游。Compose 给予 10 秒停止宽限期。
- 模型目录正常缓存 5 分钟；目录故障只保留已确认结果，每 10 秒允许一次重试，恢复后按新目录移除下架或不符合规则的模型。

## 尚未完成

Responses 和 Anthropic Messages 的文本、流式及工具适配已通过本地 HTTP 测试；图片、独立推理块和完整客户端兼容仍待完善。工具调用尚未通过真实模型验证。双架构镜像已通过 CI 构建及启动测试，GHCR 发布和匿名拉取仍在验证。
