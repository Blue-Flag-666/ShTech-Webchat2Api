# 上海科技大学 Webchat 本地 API

同类 GitHub 项目比较见 [GITHUB_COMPARISON.md](GITHUB_COMPARISON.md)。多架构 Docker 部署见 [compose.yaml](compose.yaml)。

Windows Docker Desktop、Linux、树莓派与验证状态见 [DEPLOYMENT.md](DEPLOYMENT.md)。GHCR 镜像已发布并验证可匿名读取，包含 linux/amd64 和 linux/arm64。

将学校 Webchat 适配为 `/v1/chat/completions`、`/v1/responses` 和 `/v1/messages`。支持文本、工具调用、SSE 流式和非流式响应，无第三方运行依赖，需要 Node.js 26 或更新版本。

## 启动

1. 将 `.env.example` 复制为 `.env`。
2. 从本人已登录网页的聊天请求填写 `GENAI_TOKEN`（`x-access-token`）和 `GENAI_CHAT_GROUP_ID`。不要把凭证提交到代码仓库。
3. 为 `API_KEY` 设置一个独立的随机密钥，可运行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成。
4. 运行 `node --env-file=.env server.mjs`（也可使用 `npm start`）。默认地址为 `http://127.0.0.1:8787/v1`。

客户端填写 Base URL `http://127.0.0.1:8787/v1`、本地 `API_KEY` 和模型 `qwen-instruct`。

```javascript
const response = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer 你的本地API_KEY' },
  body: JSON.stringify({
    model: 'qwen-instruct',
    messages: [{ role: 'user', content: '你好' }],
    stream: false
  })
});
console.log(await response.json());
```

将 `stream` 设为 `true` 获取 SSE。每条 `data:` 为 JSON，正常结束发送 `[DONE]`。流已开始后的错误通过 `event: error` 返回，不伪造正常结束。

## 行为与限制

- 本地接口（包括 `GET /health`、`GET /v1/models`）需要 Bearer 密钥，Messages 也接受 `x-api-key`。`/v1/models` 每 5 分钟读取学校模型目录，失败时保留上次确认结果；首次失败时返回空列表并拒绝聊天，不猜测模型是否自部署。`health` 仅检查适配服务状态和配置是否存在，不代表上游可用。
- `GET /healthz` 不需要密钥，仅用于 Docker/Kubernetes liveness 检查；对外使用时仍应通过端口绑定或反向代理限制访问。
- 上游始终请求流式输出；非流式由本地汇总。最后一条 user 消息映射为 `chatInfo`，其余历史映射为 `messages`。
- 可用参数：`model`、`messages`、`stream`、`max_tokens`（1–16384）、`chat_group_id`、`net_go`、`tools`、`tool_choice`。支持文本 user/assistant/system/developer 和配对的工具结果。
- 工具调用通过当前请求中的提示词声明和 `<api_tool_call>` JSON 解析实现；旧 `<tool_call>` 输出也可解析。Qwen 已真实验证三个协议的工具调用及结果回传。带工具声明的流式请求先缓冲完整回答，解析成功后输出工具分块；错误格式、未知工具及 required 未遵循会报错。代理不会执行工具。
- Responses 支持文本 input、instructions、function/custom/namespace 工具、allowed_tools、推理摘要及调用结果历史；Messages 支持文本、system、thinking、tool_use/tool_result 和 `x-api-key` 鉴权。两个协议均有流式与非流式实现，详见 [PROTOCOLS.md](PROTOCOLS.md)。
- 三个协议支持提示加本地校验形式的 JSON 对象/JSON Schema 输出；它不是上游原生约束解码。图片仍待实现，不宣称完整兼容所有客户端。
- CAS/OAuth 自动登录已通过真实账号登录验证（2026-09-13）。可配置 `GENAI_USERNAME` / `GENAI_PASSWORD`，也支持 `_FILE` secret 文件；仅 JWT 模式仍需手动更新过期凭证。当前需要网页会话 ID；若上游需要 Cookie，可填写 `GENAI_COOKIE`。
- 同一服务一次只处理一个上游聊天请求，重叠请求返回 429，减少共用网页会话造成的冲突。不要在网页中同时操作同一会话。
- 默认绑定回环地址，Docker 内监听 `0.0.0.0`，宿主机端口仍默认绑定回环。不会关闭 TLS 校验；运行环境需能够正常连接学校服务。
- 总超时默认 120 秒；客户端断开会取消上游。请求限 1 MiB，累计文本响应限 8 MiB。
- 不记录登录凭证或聊天正文。上游异常正文不会转发给客户端。
- 学校聊天接口返回的 CSP 响应头包含不规范换行，默认 Node fetch 会拒绝解析。本服务仅对固定上游使用兼容 HTTP 响应解析，每次新建连接、不跟随重定向，仍校验 TLS 证书；不转发上游 Cookie 和 CSP。

## Docker（amd64 / arm64）

镜像从官方 `node:26.8.2-alpine` 复制 Node 可执行文件到 `alpine:3.24.1`，最终层不包含 npm、Corepack、开发头文件或测试。GitHub Actions 会构建并发布 `linux/amd64` 和 `linux/arm64` manifest。将 `.env.example` 复制为 `.env` 并填写凭证后：

```bash
docker compose pull
docker compose up -d --no-build
docker compose logs -f
```

默认只把端口绑定到宿主机回环地址。树莓派使用 64 位 Raspberry Pi OS 时直接拉取同一镜像即可；如需局域网访问，显式修改 `compose.yaml` 的 `ports`，并自行配置防火墙。镜像发布工作流位于 `.github/workflows/container.yml`，推送到 GitHub 后会使用 `GITHUB_TOKEN` 发布到 `ghcr.io/<owner>/shtech-webchat2api`。

## 验证

`node --test`（或 `npm test`）使用本地模拟上游检查请求映射、中文跨字节 SSE、流式/非流式 HTTP 请求、截断、登录失败和超时。这些测试不能证明学校服务当前连通或会话有效；需要配置本人凭证后完成真实调用验证。

配置完成后运行 `node --env-file=.env verify.mjs`，会发送一条简短测试消息到学校服务，输出 HTTP 状态和回答。此操作会使用该账号和已配置会话。

使用 `node --env-file=.env verify.mjs --stream` 验证真实 SSE 分块和结束标记。

## 依赖更新策略

项目新增依赖时采用当时的最新稳定版本，并避免加入运行时依赖，除非标准库无法可靠实现。OpenAI 与 Anthropic 官方 SDK 仅作为 CI 开发依赖，用于验证真实客户端调用，不进入最终镜像。`.github/dependabot.yml` 每周检查 npm、Docker 基础镜像和 GitHub Actions；升级由 GitHub Actions 在 Windows、Linux、amd64 和 arm64 环境验证后合并。
