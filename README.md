# 上海科技大学 Webchat API

将 `genai.shanghaitech.edu.cn` Webchat 转换为兼容 OpenAI Chat Completions、Responses 和 Anthropic Messages 的本地 API。重点适配学校部署的 Kimi K3，供 OpenCode 和其他代码 Agent 使用；模型目录只暴露学校明确标记为 Xinference 自有部署的聊天模型。

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

OpenCode：保持服务运行，在另一个终端执行下列命令，将输出完整复制到项目或用户的 `opencode.json`。它会让每个校内部署模型只显示一次，默认使用 Kimi K3，并填入本地 API Key。

```bash
.\shtech-webchat2api-windows-x64.exe opencode
./shtech-webchat2api-linux-x64 opencode
```

使用 OpenCode V2 时，把命令末尾的 `opencode` 换成 `opencode-v2`。

其他客户端也使用上方的 Base URL、API Key 和 `/v1/models` 中的模型 ID：

- [Hermes Agent](https://github.com/hermes-agent-org/hermes/blob/main/website/docs/integrations/providers.md)：运行 `hermes model`，选择 Custom endpoint，填入这三项。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)：在 Settings → Models 选择 Add model provider → Custom model API，Provider ID 填 `shtech`，协议选择 OpenAI Chat Completions，再填入这三项。
- [AiderDesk](https://aiderdesk.hotovo.com/docs/configuration/providers)：在 Model Library 添加 OpenAI Compatible，填入这三项；选择模型时使用 `openai-compatible/` 前缀。

生成的配置含本地 API Key，请勿提交到 Git 或分享。

CI 使用实际 OpenCode、Hermes Agent、DeepSeek Harness 和 AiderDesk 验证 Kimi、DeepSeek、GLM、Qwen 四个模型路由的流式工具调用、文件读取、修改和结果回传，并检查 Pi AI 协议客户端。模型回答由测试数据模拟，不代表学校真实模型已通过相同任务。模型目录通过 `context_window` 提供上下文长度，通过 `max_completion_tokens` 提供保守输出预算，避免客户端把全部上下文当作输出额度。

重新配置可在终端运行：

```bash
.\shtech-webchat2api-windows-x64.exe init --force
./shtech-webchat2api-linux-x64 init --force
```

若客户端无法连接模型，可在服务运行时用同一程序执行 `doctor`，检查学校模型目录是否可访问。

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

# 默认每次请求自动生成；只有上游账号要求固定网页会话时填写
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
| `POST /v1/responses` | Bearer `API_KEY` | `input`、instructions、function/custom/namespace 及 Agent shell、apply patch、computer、programmatic tools | `response.completed` 或 `response.incomplete` |
| `GET/DELETE /v1/responses/{id}` | Bearer `API_KEY` | 读取/删除 Response；`?stream=true&starting_after=N` 可断线续传 | JSON / SSE |
| `POST /v1/responses/{id}/cancel` | Bearer `API_KEY` | 取消 `background:true` 后台响应 | JSON |
| `POST /v1/responses/compact`、`POST /v1/responses/input_tokens` | Bearer `API_KEY` | Kimi 压缩长上下文、估算 Responses 输入 token | JSON |
| `/v1/conversations`、`/v1/conversations/{id}/items` | Bearer `API_KEY` | 创建、读取、更新、删除对话及分页管理对话项 | JSON |
| `/v1/files`、`/v1/files/{id}`、`/v1/files/{id}/content` | Bearer `API_KEY` | 上传、列出、读取和删除文本、代码、Notebook、仓库 ZIP/TAR、PDF、Office、OpenDocument 及 EPUB | JSON / 原文件 |
| `/v1/uploads`、`/v1/uploads/{id}/parts`、`complete`、`cancel` | Bearer `API_KEY` | OpenAI 兼容的分片上传，完成后生成 File | JSON |
| `/v1/batches`、`/v1/batches/{id}`、`cancel` | Bearer `API_KEY` | 通过 `purpose=batch` 的 JSONL 文件批量执行 Chat、Responses 或 Completions 请求 | JSON / 结果文件 |
| `/v1/vector_stores`、`files`、`file_batches`、`search` | Bearer `API_KEY` | 建库、附加文件、批量摄取、属性过滤和本地文本检索 | JSON |
| Responses `file_search` | Bearer `API_KEY` | 从一个或多个本地 Vector Store 检索片段，并交给学校模型回答 | JSON / SSE |
| `POST /v1/messages` | `x-api-key` 或 Bearer | `messages`、system、tool_use/tool_result | `message_stop` |
| `POST /v1/messages/count_tokens` | `x-api-key` 或 Bearer | 估算 Anthropic 输入 token | JSON |
| `GET /v1/models` | Bearer `API_KEY` | 学校自有部署聊天模型列表 | JSON |
| `GET /v1/models/{id}` | Bearer `API_KEY` | 单模型查询 | JSON |

本地鉴权同时接受 `Authorization: Bearer`、`x-api-key` 和 `api-key`。

### 与普通 API 提供商的协议差异

这里的“普通 API 提供商”指直接提供模型推理接口、兼容 OpenAI 或 Anthropic 协议的云服务。各家实际支持范围不同；下表以完整的 OpenAI Chat Completions、Responses 和 Anthropic Messages 服务为对照。本项目首先保证 OpenCode 等代码 Agent 所需的常用调用能够工作，不代表完整复刻任一云平台。

| 对比项 | 本项目 | 普通 API 提供商 |
|---|---|---|
| 请求路径 | 同时提供 Chat Completions、Responses、传统 Completions 和 Anthropic Messages 常用接口 | 通常提供其中一种或多种原生接口，支持范围由提供商决定 |
| 模型与鉴权 | 本地 API Key 验证客户端，再通过 CAS 或网页 token 访问学校 Webchat；模型来自学校 Xinference 目录 | 客户端直接使用提供商签发的 API Key，请求直接进入模型服务 |
| 流式响应 | 将学校 EventStream 转换成 OpenAI SSE 或 Anthropic SSE，并生成对应的结束事件 | 由推理后端直接生成协议事件，字段和时序通常更完整 |
| 工具调用 | 支持 function、custom、namespace、Anthropic tool，以及 Responses 的 local shell、shell、apply patch、computer 输出项；`program` 仅映射输出项与历史，不提供官方托管执行环境。模型通过提示词产生调用，本地解析后由客户端执行工具 | function calling 通常由模型原生输出；部分平台还会在服务端执行搜索、代码解释器、MCP 等内置工具 |
| 结构化输出 | 支持 JSON Object 和 JSON Schema，但依赖提示词生成与本地校验 | 支持时通常使用模型原生约束解码，格式保证更强 |
| 联网搜索 | 将 Chat、Responses 和 Anthropic 搜索请求映射到 Webchat 的 `netGo`；不伪造原生搜索调用、步骤或引用事件。2026-10-14 网页实测可返回来源链接，但学校搜索流程可能附加固定回答模板，影响简洁回答、JSON 和工具调用格式 | 支持时可返回完整工具调用生命周期、来源和引用信息 |
| 多轮状态 | 支持 `previous_response_id`、Conversations、后台任务、取消和流式续传；Conversations 持久化到本地，Responses 正文只在当前进程保存 | 通常由云端持久化，并按平台的数据保留策略跨进程提供 |
| 文件、检索与批处理 | 兼容 Files、分片 Uploads、Vector Stores、`file_search` 和 Batches；可提取文本、代码、补丁与测试日志摘要、Notebook、带目录树和文件概况的仓库 ZIP/TAR/tar.gz、RTF、纯文本型 DOC、带文本层 PDF、DOCX、PPTX、XLSX、ODT、ODS、ODP、EPUB，检索使用本地词法相关度，Batch 在本地队列中逐条调用学校 Webchat | 通常使用持久对象存储、Embedding 向量检索和独立批处理算力，还可能提供原生重排与微调 |
| Token 与缓存 | 提供兼容的 token 估算和 usage 字段，无法取得 Kimi K3 的精确内部 tokenizer、缓存命中与计费信息 | 由原生 tokenizer 和计费系统返回精确用量及缓存数据 |
| 并发与可靠性 | 受学校 Webchat 能力限制，默认单并发排队，并在流开始前有限重试 | 通常提供明确的 RPM/TPM 配额、弹性并发和服务等级 |
| 尚未覆盖 | Realtime、embeddings、reranker、微调、音频、视频及其他原生服务端工具；管理页、OCR、MCP、结果缓存和精确 tokenizer 不在当前目标内 | 是否支持取决于提供商；完整平台通常覆盖其中更多资源 |

因此，本项目可作为常用 SDK 和代码 Agent 的兼容接入层，尤其适合使用学校 Kimi K3 完成文本、图片、工具调用和长上下文开发任务。依赖精确计费、持久云端状态、原生内置工具或未列出的资源接口时，不能视为普通云 API 的无差别替代品。

三个聊天接口均支持流式与非流式文本、工具调用、推理摘要、图片输入和 JSON/JSON Schema 输出。Anthropic `document` 支持纯文本、Base64 PDF 和本项目的文件 ID，也可放在工具结果中；远程文档 URL 和原生 citations 尚未支持。上下文预算使用近似 token 估算，并计入输出额度、工具声明和格式提示；自动缩减后仍超出窗口时，在上传附件或发送上游前返回错误。Kimi K3 额外兼容 `reasoning_effort`、原生 `thinking` 配置、历史 `reasoning_content`、Partial Mode、动态工具、学校目录中的 1048576 token 上下文限制，以及 Moonshot 的 `/v1/tokenizers/estimate-token-count` 和 `/anthropic/v1/messages` 路径。Responses 还接受并校验 `max_tool_calls`、`stream_options.include_obfuscation`、`reasoning.summary`、`text.verbosity`、`metadata`、`service_tier`、`safety_identifier` 和 `prompt_cache_key`；其中缓存键只作为兼容字段回显，本项目不会建立通用提示词或结果缓存。

工具由客户端执行，服务负责声明、解析、参数 Schema 校验和回传，并落实串行模式与 `max_tool_calls` 数量限制。流式请求会即时发送普通文本，并在模型写完工具调用块后立即发送对应协议事件；跨分片标签与未完成的工具 JSON 不会作为文本泄漏。解析器还支持 JSON 代码围栏、BOM 和常见尾随逗号，同时继续拒绝模糊或不符合 Schema 的参数。设置 `GENAI_OUTPUT_REPAIR=true` 后，工具及结构化输出请求会先缓冲并校验完整答案，必要时额外请求模型定向修复一次，再发送客户端事件，避免提前执行原始答案中的工具或重复输出。该模式会增加首个事件的等待时间；关闭时继续增量输出。Webchat 没有公开原生工具参数入口，因此工具及结构化输出通过提示词生成并在本地校验；上下文缓存、请求签名、Formula 工具和原生约束解码无法由该代理复刻。

聊天与 Responses 的 POST 请求可附带 `Idempotency-Key`。10 分钟内相同键和请求体会复用已成功完成的响应；同一键配不同请求体返回 409，响应过大无法重放时也返回 409，避免再次调用学校模型。Responses 的 `program` 映射仅供能自行执行并回传结果的客户端使用，不能替代 OpenAI 托管的 Programmatic Tool Calling 运行时。

Chat 支持 `max_tokens`、`max_completion_tokens`、`stream_options.include_usage`、`tools`、`tool_choice`、`response_format`、常用采样参数和 `net_go`；Kimi K3 的采样参数按官方范围校验。Responses 默认在进程内保存，支持 `item_reference`、`previous_response_id`、`conversation`、`background:true`、后台流式输出、按事件序号断线续传、Kimi 上下文压缩、输入 token 估算、`truncation:auto`、`context_management`、状态轮询、取消、读取、删除和输入项查询。Chat 与 Anthropic 默认在接近上下文窗口时按完整轮次缩减历史，可设 `GENAI_CONTEXT_AUTO=false` 关闭；Responses 由 `truncation:auto` 或 `context_management` 控制。默认 `GENAI_CONTEXT_STRATEGY=agent` 会压缩长工具结果并优先保留补丁和错误，也可设为 `recent` 只保留最近轮次。`store:false` 会返回由本地 API Key 加密、可跨进程回放的不透明 reasoning 数据；更换 API Key 后旧数据无法解密。Conversations 支持完整资源和对话项管理并持久化到本地；模型 Response 正文仍只保存在当前进程，避免形成结果缓存。

图片支持 URL、Base64、Files API 的 `file_id`、用户输入、工具结果截图和 `computer_call_output` 截图；程序会从学校公开网页自动读取上传凭据，`GENAI_UPLOAD_TOKEN` 只用于覆盖。Files、Uploads、Vector Stores、Conversations 和已结束的 Batches 会逐资源原子持久化，新写入记录带校验和，损坏记录会被隔离并尝试从上一版本恢复，同一数据目录只允许一个服务实例写入；单文件程序默认使用 `.env` 旁的 `data` 目录，Docker 使用 `shtech-webchat-data` 数据卷。Responses `input_file` 及工具返回的文本、代码、带文本层 PDF、DOCX、PPTX、XLSX、ODT、ODS、ODP 和 EPUB 默认带文件名注入文本上下文；设置 `GENAI_NATIVE_FILE_UPLOAD=true` 可改用学校网页的原生文件上传和 `fileIds`。项目将单个文件、单张图片和单次请求文件总量限制为严格小于 10 MiB；当前网页前端对普通文件采用小于 10 MiB、对图片采用小于 20 MiB 的限制，学校官方 FAQ 另公布了[网页文件总大小上限](https://aiplat.shanghaitech.edu.cn/2024/0329/c16279a1114412/page.htm)。PDF 上限 200 页，压缩文档解压上限 32 MiB，扫描版 PDF 和文档内嵌图片不做 OCR。Uploads API 支持创建、追加分片、校验、完成和取消。Vector Stores 支持文件和批次管理、静态或自动分块、属性过滤、搜索及 Responses `file_search`；本地没有 Embedding 模型，相关度来自中英文词法匹配，检索片段再由学校 Kimi K3 生成答案。Batches API 支持最多 50000 条 JSONL 请求、状态查询、分页、取消、用量汇总及独立成功/错误文件；任务复用普通请求队列，不提供商业 Batch API 的折扣或额外并发。未结束的 Batch 若遇服务重启会被明确标记为失败，避免重复执行请求。Responses 可声明、流式返回并回放 OpenCode 使用的 local shell、shell、apply patch、program 和 computer 原生工具项；Chat 与 Anthropic 接口仍使用通用 function/tool_use 形式。Kimi K3 会被识别为视觉模型。Chat `web_search_options`、Responses `web_search` 和 Anthropic 服务端搜索工具会映射到 Webchat 的 `netGo`，搜索过程不会伪造原生工具事件。视频、音频、embeddings 和 reranker 尚未支持。请求默认按单并发排队，对 429、502、503、504 在流开始前有限重试；上游 `Retry-After` 支持秒数与 HTTP 日期，超过本地等待上限时会转发给客户端。连续上游故障会按模型熔断，冷却后进行单次探测；全局并发和队列由 `GENAI_CONCURRENCY`、`GENAI_QUEUE_SIZE` 控制，模型专属上限可在 `.env` 的 `GENAI_MODEL_LIMITS` 中设置。

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

设置 `GENAI_LOG_FILE=data/access.log` 可开启自动轮转的脱敏访问日志，仅记录请求 ID 的短哈希、归一化路由、状态码和耗时。项目不会把登录凭证或聊天正文写入日志；`store:true` 的 Responses 历史只保存在当前进程内存中。持久化目录包含用户上传文件、对话和检索内容，应与 `.env` 一样妥善保管。可用 `GENAI_DATA_QUOTA_MB` 限制数据目录总量，默认 `0` 为不限；空间不足时写入返回 507。`/healthz` 只表示代理进程存活；携带本地 API Key 访问 `/health?upstream=1` 会实际探测学校模型目录，成功返回 200，失败返回 503，同一结果缓存 30 秒。携带本地 API Key 访问 `/metrics` 可获取 Prometheus 请求、耗时、队列和存储指标。

浏览器页面跨域访问时，在 `.env` 中把 `CORS_ORIGIN` 设置为该页面的完整来源；命令行和桌面客户端无需设置。

常用诊断命令：

```bash
shtech-webchat2api doctor
shtech-webchat2api status
shtech-webchat2api models
```
