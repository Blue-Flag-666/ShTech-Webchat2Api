# GitHub 同类项目比较

检索日期：2026-09-12。重点比较了直接访问 `genai.shanghaitech.edu.cn/htk` 的项目；只把仓库 README、源码和测试中明确出现的能力列为已实现。

## 直接相关项目

| 项目 | 形态与接口 | 鉴权 | 主要能力 | 与当前项目的差异 |
|---|---|---|---|---|
| [ShanghaitechGeekPie/GenAI2OpenAI](https://github.com/ShanghaitechGeekPie/GenAI2OpenAI) | Flask；OpenAI Chat Completions | JWT 或学号密码 | 原始基线；流式/非流式、模型列表、基础 OpenAI 兼容 | 当前项目的上游请求验证和最小实现更小；该项目模型和协议覆盖更广，但 README 自称维护动力较低 |
| [HeZeBang/GenAI2OpenAI](https://github.com/HeZeBang/GenAI2OpenAI) | Flask；`/v1/chat/completions`、`/v1/responses`、`/v1/messages` | JWT 或 CAS 自动登录/刷新 | 多模型适配、推理字段、图片、工具调用、Responses、Docker、动态模型列表 | 功能最完整，适合借鉴模型注册、token 刷新和多协议设计；复杂度和上游假设也最高 |
| [cmjang/shanghaitech-genai2api](https://github.com/cmjang/shanghaitech-genai2api) | Python/uv；OpenAI + Anthropic | JWT 或学号密码 | Claude Code 适配、自动刷新、工具调用提示词转换、动态模型 | 是较新的独立实现；与当前项目相比提供 Anthropic 接口和凭证登录，但仍依赖同一 JWT/网页上游 |
| [jollyxenon/shanghaitech-genai2api](https://github.com/jollyxenon/shanghaitech-genai2api) | Python/pixi；OpenAI Chat、Responses + Anthropic Messages | JWT 或 CAS | 面向 Claude Code 和 Codex；Responses 支持 `function_call`、`custom_tool_call`、reasoning 事件；自动刷新、动态模型列表、上下文探测和速度基准 | 比 cmjang 的公开说明更明确地补齐 Codex Responses；代价是 Responses 只做兼容子集、无服务端 response storage、工具调用依赖 prompt 注入和文本解析 |
| [Rainy-14b/GenAI2Codex](https://github.com/Rainy-14b/GenAI2Codex) | Python/uv；重点兼容 OpenAI Responses | JWT | Codex 配置、Responses、模型适配、字符修正 | 对 Codex 更方便，但 README 明确仍在开发 Anthropic；当前项目已验证 Chat Completions，尚未实现 Responses |

## 当前项目的实际位置

当前项目是一个 Node.js 22、零第三方依赖的本地小型代理，已经真实验证：

- `POST /v1/chat/completions` 的流式和非流式调用。
- 上游 `POST /htk/chat/start/chat` 的 SSE 解析，包括中文跨 UTF-8 分块、CR/LF/CRLF、多行 data 和 `[DONE]`。
- 本地 Bearer API key、请求大小限制、单请求并发限制、客户端断开取消、超时和错误事件。
- 学校上游不规范 CSP 响应头的兼容处理；固定上游、TLS 校验保持开启、不跟随重定向。

与 GitHub 上成熟实现相比，当前项目明确暂不支持：自动 CAS 登录/刷新、动态模型目录、多模型路由、Anthropic Messages、OpenAI Responses、图片上传、工具调用和 reasoning 字段。

## 值得吸收的设计

1. **token 管理**：HeZeBang 和 cmjang 都支持学号密码 CAS 登录，并在 JWT 过期后刷新。当前项目只接受已抓取的 JWT；如果长期运行，这是最优先的增强项。不要直接把密码放入现有 `.env`，应使用独立的 keystore 或系统凭证存储。
2. **动态模型列表**：相关项目使用 `GET /htk/ai/aiModel/list`，而当前 `/v1/models` 只有固定的 `qwen-instruct`。接入前应先读取并记录真实返回结构，不能照搬模型名称映射。
3. **SSE 失败处理**：成熟项目会识别上游首帧的 token 失效/业务错误，并在开始输出前重试或返回标准错误。当前项目已拒绝无完成标记的截断流，但还可以增加上游业务错误 JSON 的识别。
4. **协议扩展**：如果目标是 Codex，优先参考 GenAI2Codex 的 Responses 接口；如果目标是 Claude Code，优先参考 cmjang/HeZeBang 的 Anthropic Messages 转换。两者都不应在没有真实回归测试前直接合并。
5. **测试隔离**：HeZeBang 的测试把本地 mock、上游 transport 和显式 live 测试分开。当前项目已有 mock 端到端测试和真实 `verify.mjs`，可以沿用这个边界。

## jollyxenon 项目的特别比较

jollyxenon 不是只增加一个别名：它把三个协议放在同一个代理里，并针对 Codex 的 `wire_api = "responses"` 做了事件级适配。README 明确列出 `function_call`、`custom_tool_call`、reasoning summary 事件，以及客户端每轮发送完整历史的无状态模式；同时还提供 CAS 登录、动态模型列表、上下文上限探测和速度基准工具。[项目 README](https://raw.githubusercontent.com/jollyxenon/shanghaitech-genai2api/main/README.md)

源码还显示它会从 `/htk/ai/aiModel/list` 缓存模型，读取 `aiType`、`rootAiType` 和 `maxToken`，并实现了与上海科技大学 CAS 登录页配套的 AES-CBC 密码加密登录流程。[config.py](https://github.com/jollyxenon/shanghaitech-genai2api/blob/main/config.py)、[cas_login.py](https://github.com/jollyxenon/shanghaitech-genai2api/blob/main/auth/cas_login.py)

它的限制同样需要保留在比较中：Responses 不支持 `previous_response_id` 或服务端存储；工具调用是提示词注入加文本解析；usage 是本地估算；`reasoning_effort` 等参数会被接受但忽略。也就是说，它比当前项目覆盖面大，但不是上游原生 OpenAI/Anthropic 协议，不能把“接口存在”理解成完整语义兼容。

## 结论

当前实现已经完成“把网页聊天转为可调用的本地 OpenAI Chat Completions API”，并且真实调用过上游。GitHub 上的 HeZeBang/GenAI2OpenAI 是功能最完整的参考实现；cmjang/shanghaitech-genai2api 更适合作为 Claude Code 和自动登录参考；Rainy-14b/GenAI2Codex 更适合作为 Responses/Codex 参考。直接替换为这些项目没有必要：它们的优势集中在额外协议、模型适配和登录管理，而当前项目的优势是依赖少、行为边界清楚、真实 SSE 已验证。

## 来源与可复核证据

- [GenAI2OpenAI 原始 README](https://raw.githubusercontent.com/ShanghaitechGeekPie/GenAI2OpenAI/main/README.md)：OpenAI 兼容、流式/非流式和项目基线。
- [HeZeBang README](https://raw.githubusercontent.com/HeZeBang/GenAI2OpenAI/main/README.md)：Responses、Anthropic、工具调用、图片、自动刷新和动态模型列表。
- [HeZeBang provider/genai.py](https://github.com/HeZeBang/GenAI2OpenAI/blob/main/provider/genai.py)：SSE、token 失效检测、重试和 usage 处理。
- [cmjang README](https://raw.githubusercontent.com/cmjang/shanghaitech-genai2api/main/README.md)：Claude Code、JWT/CAS 两种模式和自动刷新。
- [Rainy-14b/GenAI2Codex README](https://raw.githubusercontent.com/Rainy-14b/GenAI2Codex/main/README.md)：Codex 的 Responses 配置和模型适配方向。
- [jollyxenon/shanghaitech-genai2api README](https://raw.githubusercontent.com/jollyxenon/shanghaitech-genai2api/main/README.md)：三协议、Codex 事件、CAS 刷新、模型缓存和已知限制。
- [jollyxenon config.py](https://github.com/jollyxenon/shanghaitech-genai2api/blob/main/config.py)：模型列表接口和模型元数据字段。
- [jollyxenon CAS 登录](https://github.com/jollyxenon/shanghaitech-genai2api/blob/main/auth/cas_login.py)：统一身份认证登录流程。
- [GitHub API 仓库元数据](https://api.github.com/repos/HeZeBang/GenAI2OpenAI)：星标、fork、许可证和最新提交可复核。
