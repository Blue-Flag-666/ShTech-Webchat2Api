# 部署与验证

## 平台

| 运行环境 | 方式 | 验证状态 |
|---|---|---|
| Windows amd64 | Node.js 26+ 原生 | GitHub Actions `windows-latest` 测试通过 |
| Windows Docker Desktop | Linux 容器后端 | Compose 配置可直接使用；未按要求在本机 Docker Desktop/WSL 实测 |
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

GHCR 已发布 `ghcr.io/blue-flag-666/shtech-webchat2api:latest`，同一标签包含 linux/amd64 和 linux/arm64，并已匿名读取 manifest 验证。使用 `docker compose pull` 和 `docker compose up -d --no-build` 可跳过本地构建。

非容器运行：`node --env-file=.env server.mjs`。客户端 Base URL 为 `http://127.0.0.1:8787/v1`。

## 配置与资源

- `API_KEY` 必填，与学校 token 独立。
- `GENAI_TOKEN` 可使用现有网页 JWT；过期后更新。配置 CAS 用户名和密码时，代理在过期前、HTTP 401 或首个 SSE 登录失效事件后重新登录。HTTP/SSE 共用一次重试预算，输出正文后不重试。
- `GENAI_PASSWORD_FILE`、`GENAI_TOKEN_FILE`、`API_KEY_FILE` 可以指向只读 secret 文件。服务不将刷新后的 token 持久化到磁盘。
- 2026-09-13 已真实验证 CAS/OAuth 自动登录取得 token，以及现有网页 token 的非流式和 SSE 聊天。验证码或登录页变更会报错，不会绕过人工验证。`node --env-file=.env verify.mjs --cas` 可强制从账号密码登录后验证聊天。
- Chat 普通流式回复不累计整段正文；Responses/Messages 为组装最终响应保留正文，工具请求也需汇总后解析。单事件上限 1 MiB，累计回复上限 8 MiB。
- 模型目录 5 分钟缓存、共享并发查询，避免重复访问学校接口。只保留明确使用 Xinference 路由的已知国内模型家族，未知路由不猜测为自部署。
- 最终镜像仅保留 Node 可执行文件、许可证、CA 证书和必要 C++ 运行库，不含 npm、Corepack、开发头文件或测试。提交 6fefbdb 的 CI 测量为：amd64 解压大小 160,590,028 字节、空闲约 19.09 MiB；arm64 解压大小 158,033,046 字节。arm64 的 QEMU 内存值不能代表树莓派，完整口径见 [RESOURCE_REPORT.md](RESOURCE_REPORT.md)。
- Compose 只读、非 root、移除 capabilities，并默认只将端口暴露在宿主机回环地址。
- SIGTERM / Ctrl+C 停止接收新请求，允许进行中的请求在 5 秒内完成，超时断开并取消聊天上游。Compose 给予 10 秒停止宽限期。
- 模型目录正常缓存 5 分钟；目录故障只保留已确认结果，每 10 秒允许一次重试，恢复后按新目录移除下架或不符合规则的模型。

## 已验证边界与待实测项

三个协议均已使用学校 Qwen 真实验证文本 JSON、文本 SSE、工具调用及结果回传；当前 OpenAI 7.15.0 与 Anthropic 0.125.0 官方 SDK 也在 Windows/Linux CI 中验证。推理摘要已映射为 Responses reasoning item 和 Messages thinking 块。双架构镜像已通过 CI 构建、内置测试和 HTTP 启动检查，GHCR 已发布。

图片、音频、内置搜索工具和有状态 Responses 明确不支持。按要求没有在本机 Windows、WSL 或 Docker Desktop 运行测试；树莓派实机资源表现和 Codex/Claude Code 命令行端到端仍待实机验证。
