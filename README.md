# 上海科技大学 Webchat API

将学校 GenAI Webchat 转为 OpenAI Chat Completions、Responses 和 Anthropic Messages 兼容 API，可用于 OpenCode、Hermes、DeepSeek Harness 和 AiderDesk。只提供学校自部署模型，默认使用 Kimi K3。

**转换服务必须运行在能够访问 GenAI 的校内网络。**

## 下载安装

从 [Releases](https://github.com/Blue-Flag-666/ShTech-Webchat2Api/releases/latest) 下载对应的单文件程序，无需安装 Node.js：

| 系统 | x64 | ARM64 |
|---|---|---|
| Windows | `shtech-webchat2api-windows-x64.exe` | `shtech-webchat2api-windows-arm64.exe` |
| Linux | `shtech-webchat2api-linux-x64` | `shtech-webchat2api-linux-arm64` |

Windows 双击程序。Linux 运行（ARM64 请替换文件名）：

```bash
chmod +x shtech-webchat2api-linux-x64
./shtech-webchat2api-linux-x64
```

首次启动按提示输入 CAS 学号和密码，程序自动生成 API Key 和 `.env`。以后直接运行即可，数据保存在程序旁的 `data/`。

## 接入客户端

```text
Base URL: http://127.0.0.1:8787/v1
API Key:  程序显示的 API_KEY（也保存在 .env）
Model:    kimi-k3
```

其他模型 ID 可用程序的 `models` 命令或 `GET /v1/models` 查询。

OpenCode：在另一个终端运行对应命令，将输出复制到 `opencode.json`：

```powershell
.\shtech-webchat2api-windows-x64.exe opencode
```

```bash
./shtech-webchat2api-linux-x64 opencode
```

OpenCode V2 将末尾的 `opencode` 换成 `opencode-v2`。

| 客户端 | 配置入口 |
|---|---|
| Hermes | `hermes model` → Custom endpoint |
| DeepSeek Harness | Settings → Models → Custom model API；Provider ID 填 `shtech`，选择 OpenAI Chat Completions |
| AiderDesk | Model Library → OpenAI Compatible；模型选择使用 `openai-compatible/` 前缀 |

无法连接时运行 `doctor`；重新配置使用 `init --force`。`.env` 和生成的客户端配置包含凭证，请勿上传或分享。

## Docker

支持 Linux 和 Windows Docker Desktop 的 Linux 容器模式。创建 `.env`：

```dotenv
API_KEY=自行设置的本地密钥
GENAI_USERNAME=学号
GENAI_PASSWORD=密码
```

在该目录运行：

```bash
docker run -d --name shtech-webchat-api --restart unless-stopped --env-file .env -e HOST=0.0.0.0 -p 8787:8787 -v shtech-webchat-data:/data --read-only --tmpfs /tmp:noexec,nosuid,size=16m --cap-drop ALL --security-opt no-new-privileges ghcr.io/blue-flag-666/shtech-webchat2api:latest
```

其他电脑通过 `http://服务器IP:8787/v1` 接入，填写同一个 API Key；服务器防火墙或云安全组须允许 TCP 8787。仅需本机访问时，将端口映射改为 `127.0.0.1:8787:8787`。

启动时会检查学校登录及模型访问权限，可用 `docker logs -f shtech-webchat-api` 查看结果。检查失败会记录原因，后续请求仍可重试登录。

源码部署可复制 `.env.example` 为 `.env`，填写凭证后执行 `docker compose up -d`。直接运行源码需要 Node.js 26+：

```bash
npm ci
npm start
```

## 支持与限制

- 支持流式回答、工具调用、思考内容、图片、JSON Schema，以及文件、对话、批处理和本地文本检索接口。
- 工具通过提示词生成并由客户端执行；usage 和 token 数为兼容估算，不能完全替代原生 Kimi 或商业 API。
- 文件和图片须小于 10 MiB。扫描文档 OCR、音视频、Realtime、embeddings、reranker、微调和原生缓存不支持。

可在 `.env` 设置 `GENAI_OUTPUT_REPAIR=true`，允许工具参数和结构化输出失败后定向修复一次。更多可选配置见 [.env.example](.env.example)。

CI 覆盖四个客户端及四个自部署模型路由，使用模拟上游，不访问学校接口。
