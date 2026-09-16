# 上海科技大学 Webchat API

将 `genai.shanghaitech.edu.cn` Webchat 转换为兼容 OpenAI Chat Completions、Responses 和 Anthropic Messages 的本地 API。重点适配学校部署的 Kimi K3，供 OpenCode、Codex 和其他代码 Agent 使用；同时只暴露国内 Xinference 模型。

## 快速使用

从 [Releases](https://github.com/Blue-Flag-666/ShTech-Webchat2Api/releases/latest) 下载与你电脑对应的单文件程序：

| 系统 | x64 | ARM64 |
|---|---|---|
| Windows | `shtech-webchat2api-windows-x64.exe` | `shtech-webchat2api-windows-arm64.exe` |
| Linux | `shtech-webchat2api-linux-x64` | `shtech-webchat2api-linux-arm64` |

Windows 双击 `.exe`，Linux 运行：

```bash
chmod +x shtech-webchat2api-linux-x64
./shtech-webchat2api-linux-x64
```

首次启动会提示输入 CAS 学号和密码，自动生成本地 API Key，并在程序旁创建 `.env`。以后直接运行同一个文件即可启动。程序是自带 Node.js 的单文件，不需要安装 Node、Docker 或依赖。

启动后客户端填写：

```text
Base URL: http://127.0.0.1:8787/v1
API Key:  首次启动时显示并写入 .env 的 API_KEY
Model:    kimi-k3，或通过 GET /v1/models 查询
```

OpenCode 在项目或用户配置 `opencode.json` 中填写：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "shtech/kimi-k3",
  "provider": {
    "shtech": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ShanghaiTech Kimi",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "复制 .env 中的 API_KEY"
      },
      "models": {
        "kimi-k3": {
          "name": "Kimi K3",
          "limit": { "context": 800000, "output": 131072 }
        }
      }
    }
  }
}
```

重新配置可在终端运行：

```bash
shtech-webchat2api-windows-x64.exe init --force
./shtech-webchat2api-linux-x64 init --force
```

`.env` 包含登录凭证，请勿上传或分享。

## Docker

镜像支持 Linux 和 Windows Docker Desktop。新建 `.env` 文件并填写：

```dotenv
API_KEY=自行设置一个本地API密钥

# 使用CAS账号密码自动登录
GENAI_USERNAME=学号
GENAI_PASSWORD=密码

# 如果不使用账号密码，可删除上面两行并填写网页token
# GENAI_TOKEN=网页请求中的x-access-token

# 通常不需要；只有上游账号要求固定网页会话时填写
# GENAI_CHAT_GROUP_ID=网页聊天请求中的会话ID

# 可选：网页自动发现失败时覆盖图片上传token
# GENAI_UPLOAD_TOKEN=图片上传token
```

在 `.env` 所在目录复制运行这一条命令：

```bash
docker run -d --name shtech-webchat-api --restart unless-stopped --env-file .env -p 127.0.0.1:8787:8787 --read-only --tmpfs "/tmp:noexec,nosuid,size=16m" --cap-drop ALL --security-opt no-new-privileges ghcr.io/blue-flag-666/shtech-webchat2api:latest
```

查看日志或更新镜像：

```bash
docker logs -f shtech-webchat-api
docker pull ghcr.io/blue-flag-666/shtech-webchat2api:latest
docker rm -f shtech-webchat-api
# 再运行上面的 docker run 命令
```

Windows Docker Desktop 需要使用 Linux 容器模式。

## 其他运行方式

检出源码后可使用 Compose：

```bash
cp .env.example .env
docker compose pull
docker compose up -d --no-build
```

也可以安装 Node.js 26 或更新版本后直接运行：

```bash
npm start
```

## 协议支持

| 接口 | 鉴权 | 输入与工具 | 流结束 |
|---|---|---|---|
| `POST /v1/chat/completions` | Bearer `API_KEY` | `messages`、function tools | `[DONE]` |
| `POST /v1/completions` | Bearer `API_KEY` | 单提示词及 `suffix` 补全 | `[DONE]` |
| `POST /v1/responses` | Bearer `API_KEY` | `input`、instructions、function/custom/namespace tools | `response.completed` 或 `response.incomplete` |
| `GET/DELETE /v1/responses/{id}` | Bearer `API_KEY` | 读取/删除进程内保存的 Response | JSON |
| `POST /v1/messages` | `x-api-key` 或 Bearer | `messages`、system、tool_use/tool_result | `message_stop` |
| `POST /v1/messages/count_tokens` | `x-api-key` 或 Bearer | 估算 Anthropic 输入 token | JSON |
| `GET /v1/models` | Bearer `API_KEY` | 国内自部署模型列表 | JSON |
| `GET /v1/models/{id}` | Bearer `API_KEY` | 单模型查询 | JSON |

本地鉴权同时接受 `Authorization: Bearer`、`x-api-key` 和 `api-key`。

三个聊天接口均支持流式与非流式文本、工具调用、推理摘要、图片输入和 JSON/JSON Schema 输出。Kimi K3 额外兼容 `reasoning_effort`、原生 `thinking` 配置、历史 `reasoning_content`、Partial Mode、动态工具、学校目录中的 800K 上下文限制，以及 Moonshot 的 `/v1/tokenizers/estimate-token-count` 和 `/anthropic/v1/messages` 路径。

工具由客户端执行，服务负责声明、解析、参数 Schema 校验和回传。Webchat 没有公开原生工具参数入口，因此工具及结构化输出通过提示词生成并在本地校验；上下文缓存、请求签名、Formula 工具和原生约束解码无法由该代理复刻。

Chat 支持 `max_tokens`、`max_completion_tokens`、`stream_options.include_usage`、`tools`、`tool_choice`、`response_format`、常用采样参数和 `net_go`；Kimi K3 的采样参数按官方范围校验。Responses 支持进程内 `store:true`、`previous_response_id`、读取、删除和输入项查询；默认保存一小时，服务重启后清空。

图片支持 URL 和 Base64；程序会从学校公开网页自动读取上传凭据，`GENAI_UPLOAD_TOKEN` 只用于覆盖。Kimi K3 会被识别为视觉模型。Chat `web_search_options`、Responses `web_search` 和 Anthropic 服务端搜索工具会映射到 Webchat 的 `netGo`，搜索过程不会伪造原生工具事件。视频、音频、embeddings 和 reranker 尚未支持。请求默认按单并发排队，并对建立流之前的临时上游故障有限重试；并发、队列和重试次数均可通过 `.env` 调整。

## 登录与验证

配置 CAS 账号密码后，服务会自动获取并刷新 token；也可以只填写网页中的 `GENAI_TOKEN`。支持 `GENAI_PASSWORD_FILE`、`GENAI_TOKEN_FILE` 和 `API_KEY_FILE` 等 secret 文件变量。

发送一条真实上游消息进行验证：

```bash
node --env-file=.env scripts/verify.mjs
node --env-file=.env scripts/verify.mjs --stream
```

完整兼容接口实测会消耗账号额度：

```bash
node --env-file=.env scripts/live-verify.mjs --cas
```

项目不会把登录凭证或聊天正文写入日志；`store:true` 的 Responses 历史只保存在当前进程内存中。健康检查地址为 `/healthz`；该地址只表示代理进程存活，不代表学校上游当前可用。

浏览器页面跨域访问时，在 `.env` 中把 `CORS_ORIGIN` 设置为该页面的完整来源；命令行和桌面客户端无需设置。

常用诊断命令：

```bash
shtech-webchat2api doctor
shtech-webchat2api status
shtech-webchat2api models
```
