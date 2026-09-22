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
docker run -d --name shtech-webchat-api --restart unless-stopped --env-file .env -p 127.0.0.1:8787:8787 -v shtech-webchat-data:/data --read-only --tmpfs "/tmp:noexec,nosuid,size=16m" --cap-drop ALL --security-opt no-new-privileges ghcr.io/blue-flag-666/shtech-webchat2api:latest
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
| `GET/DELETE /v1/responses/{id}` | Bearer `API_KEY` | 读取/删除 Response；`?stream=true&starting_after=N` 可断线续传 | JSON / SSE |
| `POST /v1/responses/{id}/cancel` | Bearer `API_KEY` | 取消 `background:true` 后台响应 | JSON |
| `POST /v1/responses/compact`、`POST /v1/responses/input_tokens` | Bearer `API_KEY` | Kimi 压缩长上下文、估算 Responses 输入 token | JSON |
| `/v1/conversations`、`/v1/conversations/{id}/items` | Bearer `API_KEY` | 创建、读取、更新、删除对话及分页管理对话项 | JSON |
| `/v1/files`、`/v1/files/{id}`、`/v1/files/{id}/content` | Bearer `API_KEY` | 上传、列出、读取和删除文本、代码、PDF、Office、OpenDocument 及 EPUB | JSON / 原文件 |
| `/v1/uploads`、`/v1/uploads/{id}/parts`、`complete`、`cancel` | Bearer `API_KEY` | OpenAI 兼容的分片上传，完成后生成 File | JSON |
| `/v1/batches`、`/v1/batches/{id}`、`cancel` | Bearer `API_KEY` | 通过 `purpose=batch` 的 JSONL 文件批量执行 Chat、Responses 或 Completions 请求 | JSON / 结果文件 |
| `/v1/vector_stores`、`files`、`file_batches`、`search` | Bearer `API_KEY` | 建库、附加文件、批量摄取、属性过滤和本地文本检索 | JSON |
| Responses `file_search` | Bearer `API_KEY` | 从一个或多个本地 Vector Store 检索片段，并交给学校模型回答 | JSON / SSE |
| `POST /v1/messages` | `x-api-key` 或 Bearer | `messages`、system、tool_use/tool_result | `message_stop` |
| `POST /v1/messages/count_tokens` | `x-api-key` 或 Bearer | 估算 Anthropic 输入 token | JSON |
| `GET /v1/models` | Bearer `API_KEY` | 国内自部署模型列表 | JSON |
| `GET /v1/models/{id}` | Bearer `API_KEY` | 单模型查询 | JSON |

本地鉴权同时接受 `Authorization: Bearer`、`x-api-key` 和 `api-key`。

### 与普通 API 提供商的协议差异

这里的“普通 API 提供商”指直接提供模型推理接口、兼容 OpenAI 或 Anthropic 协议的云服务。各家实际支持范围不同；下表以完整的 OpenAI Chat Completions、Responses 和 Anthropic Messages 服务为对照。本项目首先保证 OpenCode 等代码 Agent 所需的常用调用能够工作，不代表完整复刻任一云平台。

| 对比项 | 本项目 | 普通 API 提供商 |
|---|---|---|
| 请求路径 | 同时提供 Chat Completions、Responses、传统 Completions 和 Anthropic Messages 常用接口 | 通常提供其中一种或多种原生接口，支持范围由提供商决定 |
| 模型与鉴权 | 本地 API Key 验证客户端，再通过 CAS 或网页 token 访问学校 Webchat；模型来自学校 Xinference 目录 | 客户端直接使用提供商签发的 API Key，请求直接进入模型服务 |
| 流式响应 | 将学校 EventStream 转换成 OpenAI SSE 或 Anthropic SSE，并生成对应的结束事件 | 由推理后端直接生成协议事件，字段和时序通常更完整 |
| 工具调用 | 支持 function、custom、namespace 和 Anthropic tool；模型通过提示词产生调用，本地解析并校验参数，工具仍由客户端执行 | function calling 通常由模型原生输出；部分平台还会在服务端执行搜索、代码解释器、MCP 等内置工具 |
| 结构化输出 | 支持 JSON Object 和 JSON Schema，但依赖提示词生成与本地校验 | 支持时通常使用模型原生约束解码，格式保证更强 |
| 联网搜索 | 将 Chat、Responses 和 Anthropic 搜索请求映射到 Webchat 的 `netGo`；不伪造原生搜索调用、步骤或引用事件 | 支持时可返回完整工具调用生命周期、来源和引用信息 |
| 多轮状态 | 支持 `previous_response_id`、Conversations、后台任务、取消和流式续传；Conversations 持久化到本地，Responses 正文只在当前进程保存 | 通常由云端持久化，并按平台的数据保留策略跨进程提供 |
| 文件、检索与批处理 | 兼容 Files、分片 Uploads、Vector Stores、`file_search` 和 Batches；可提取文本、代码、带文本层 PDF、DOCX、PPTX、XLSX、ODT、ODS、ODP、EPUB，检索使用本地词法相关度，Batch 在本地队列中逐条调用学校 Webchat | 通常使用持久对象存储、Embedding 向量检索和独立批处理算力，还可能提供原生重排与微调 |
| Token 与缓存 | 提供兼容的 token 估算和 usage 字段，无法取得 Kimi K3 的精确内部 tokenizer、缓存命中与计费信息 | 由原生 tokenizer 和计费系统返回精确用量及缓存数据 |
| 并发与可靠性 | 受学校 Webchat 能力限制，默认单并发排队，并在流开始前有限重试 | 通常提供明确的 RPM/TPM 配额、弹性并发和服务等级 |
| 尚未覆盖 | Realtime、embeddings、reranker、微调、音频、视频及其他原生服务端工具；管理页、OCR、MCP、结果缓存和精确 tokenizer 不在当前目标内 | 是否支持取决于提供商；完整平台通常覆盖其中更多资源 |

因此，本项目可作为常用 SDK 和代码 Agent 的兼容接入层，尤其适合使用学校 Kimi K3 完成文本、图片、工具调用和长上下文开发任务。依赖精确计费、持久云端状态、原生内置工具或未列出的资源接口时，不能视为普通云 API 的无差别替代品。

三个聊天接口均支持流式与非流式文本、工具调用、推理摘要、图片输入和 JSON/JSON Schema 输出。Kimi K3 额外兼容 `reasoning_effort`、原生 `thinking` 配置、历史 `reasoning_content`、Partial Mode、动态工具、学校目录中的 800K 上下文限制，以及 Moonshot 的 `/v1/tokenizers/estimate-token-count` 和 `/anthropic/v1/messages` 路径。Responses 还接受并校验 `max_tool_calls`、`stream_options.include_obfuscation`、`reasoning.summary`、`text.verbosity`、`metadata`、`service_tier`、`safety_identifier` 和 `prompt_cache_key`；其中缓存键只作为兼容字段回显，本项目不会建立提示词或结果缓存。

工具由客户端执行，服务负责声明、解析、参数 Schema 校验和回传，并落实串行模式与 `max_tool_calls` 数量限制。解析器可安全处理 JSON 代码围栏、BOM 和常见尾随逗号，同时继续拒绝模糊或不符合 Schema 的参数。Webchat 没有公开原生工具参数入口，因此工具及结构化输出通过提示词生成并在本地校验；上下文缓存、请求签名、Formula 工具和原生约束解码无法由该代理复刻。

Chat 支持 `max_tokens`、`max_completion_tokens`、`stream_options.include_usage`、`tools`、`tool_choice`、`response_format`、常用采样参数和 `net_go`；Kimi K3 的采样参数按官方范围校验。Responses 默认在进程内保存，支持 `item_reference`、`previous_response_id`、`conversation`、`background:true`、后台流式输出、按事件序号断线续传、Kimi 上下文压缩、输入 token 估算、`truncation:auto`、`context_management`、状态轮询、取消、读取、删除和输入项查询；`store:false` 会返回可回放的不透明 reasoning 数据，便于 OpenCode 继续多轮推理。Conversations 支持完整资源和对话项管理并持久化到本地；模型 Response 正文仍只保存在当前进程，避免形成结果缓存。

图片支持 URL、Base64、Files API 的 `file_id`、用户输入、工具结果截图和 `computer_call_output` 截图；程序会从学校公开网页自动读取上传凭据，`GENAI_UPLOAD_TOKEN` 只用于覆盖。Files、Uploads、Vector Stores、Conversations 和已结束的 Batches 会逐资源原子持久化；单文件程序默认使用 `.env` 旁的 `data` 目录，Docker 使用 `shtech-webchat-data` 数据卷。Responses `input_file` 及工具返回的文本、代码、带文本层 PDF、DOCX、PPTX、XLSX、ODT、ODS、ODP 和 EPUB 会带文件名注入上下文。默认单文件上限为 10 MiB，与学校官方 FAQ 公布的[网页文件总大小上限](https://aiplat.shanghaitech.edu.cn/2024/0329/c16279a1114412/page.htm)一致；PDF 上限 200 页，压缩文档解压上限 32 MiB，扫描版 PDF 和文档内嵌图片不做 OCR。Uploads API 支持创建、追加分片、校验、完成和取消。Vector Stores 支持文件和批次管理、静态或自动分块、属性过滤、搜索及 Responses `file_search`；本地没有 Embedding 模型，相关度来自中英文词法匹配，检索片段再由学校 Kimi K3 生成答案。Batches API 支持最多 50000 条 JSONL 请求、状态查询、分页、取消、用量汇总及独立成功/错误文件；任务复用普通请求队列，不提供商业 Batch API 的折扣或额外并发。未结束的 Batch 若遇服务重启会被明确标记为失败，避免重复执行请求。Responses 还能回放 OpenCode 的 shell、apply patch、program 和 computer 工具历史。Kimi K3 会被识别为视觉模型。Chat `web_search_options`、Responses `web_search` 和 Anthropic 服务端搜索工具会映射到 Webchat 的 `netGo`，搜索过程不会伪造原生工具事件。视频、音频、embeddings 和 reranker 尚未支持。请求默认按单并发排队，并对建立流之前的临时上游故障有限重试；并发、队列和重试次数均可通过 `.env` 调整。

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

项目不会把登录凭证或聊天正文写入日志；`store:true` 的 Responses 历史只保存在当前进程内存中。持久化目录包含用户上传文件、对话和检索内容，应与 `.env` 一样妥善保管。健康检查地址为 `/healthz`；该地址只表示代理进程存活，不代表学校上游当前可用。

浏览器页面跨域访问时，在 `.env` 中把 `CORS_ORIGIN` 设置为该页面的完整来源；命令行和桌面客户端无需设置。

常用诊断命令：

```bash
shtech-webchat2api doctor
shtech-webchat2api status
shtech-webchat2api models
```
