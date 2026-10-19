# WishOS Hub

WishOS 的 Agent 连接器、MCP 服务与设备中继。运行在你自己的电脑、NAS 或服务器上，
让设备把语音与任务交给已有 Harness，并接收应用、界面和资源。

终端操作系统位于 [WishOS](https://github.com/cccat6/WishOS)。两个仓库通过版本化协议协作：
WishOS 管理设备运行时和硬件，Hub 管理上位服务、Harness 接入与资源处理。项目采用 MIT 协议。

## 开始使用

本次预览在 [Releases](https://github.com/cccat6/WishOS-Hub/releases) 提供 **macOS Apple Silicon**
安装包，包含 Node.js 与运行依赖。解压后打开 **WishOS Hub.command**。
Windows、Linux 和 Intel Mac 请按下面的源码步骤运行；本次尚未验证这些平台的独立安装包。

网页向导默认位于 `http://127.0.0.1:18762/`。按向导添加设备、选择运行器与会话，
再把生成的 MCP 配置交给 Agent。设备与电脑在同一局域网时可直接通信；启用中继后，
两端通过向外建立的连接协作，通常无需固定 DHCP 地址或设置路由器端口转发。

从源码运行需要 Node.js **24.22.0**：

```sh
npm ci
npm run build
npm run launch
```

同一套 TypeScript/JavaScript 实现运行于支持的平台。安装包按平台携带 Node 可执行文件
和 Sharp 原生图像库，Lua 预检使用共用的 WASM 编译器。

```sh
node dist/connect/cli.js setup --port 18763
node dist/connect/cli.js status
node dist/connect/cli.js stop
node dist/connect/cli.js export --client codex
node dist/connect/cli.js --stdio
```

用 `--data-dir PATH` 或 `WISHOS_HOME` 选择独立数据目录。升级时替换程序目录并保留数据目录。
本机网页管理设置、运行器、配对、语音服务及任务恢复。

## 连接已有 Agent

MCP 提供设备发现、能力查询、系统调用、资源暂存与应用交付。
设备发起任务时，Hub 通过所选 Harness 的会话入口提交；Harness 持有推理、工具、授权和历史。
MCP 连接本身与 Agent 对话会话是两种独立的状态。

| 运行器 | 当前接入入口 | 会话范围 |
| --- | --- | --- |
| Codex | App Server | 已有或新建线程，支持运行中 steer |
| Claude Code | Headless CLI | 受控的新建／恢复会话 |
| DeepSeek Harness | ACP | 运行器支持的持久会话恢复 |
| Cursor | CLI ACP | CLI 会话 |
| WorkBuddy | 获授权 Open API／ACP | 用户授权的任务会话 |
| OpenClaw | 启用的 Gateway OpenResponses | 明确的 Gateway session key |
| Hermes Agent | API Server Runs | API 所属会话 |
| ChatGPT | 远程 MCP 工具 | ChatGPT 管理的对话；设备反向发起需另有明确入口 |

接入能力取决于运行器版本、用户授权和实际提供的接口。Codex 已有真实端云验收，其他适配器
具有协议／行为测试，各自账号与环境仍需验证。具体接口、前置条件与官方文档见
[接入架构](docs/integration-architecture.md)。

希望直连模型 API 的用户可自行部署 OpenClaw、Hermes 等已有 runner，由其管理密钥、
工具循环与会话。WishOS 公共中继处理配对和转发；模型密钥与权威会话历史留在用户选择的环境。

## 语音、界面与应用

- 语音以独立可解码的压缩块传输。识别可使用已支持的 Harness 原生入口，或用户自己的在线 ASR。
- 回复可选文字或语音，语音同时保留文字。用户主机可配置 macOS 内置语音或在线兼容 TTS；
  凭据通过本机密钥存储或环境引用配置。临时回复媒体只选择设备策略允许的 RAM 目标。
- 请求进度按 boot／request／sequence 绑定，传递真实阶段与明确公开的 commentary。
- Agent 按设备声明的显示、输入、字体、存储与预算生成运行时应用。出厂套装与用户应用使用相同接口。
  首批终端支持 **LCKFB-SZPI-ESP32-S3-VA** 与 **Xingzhi Cube 1.54 TFT 单键成品**；
  其他硬件的能力由 WishOS 设备包决定。
- 资源通过暂存、预检、哈希和分块交付。应用使用完整不可变版本更新；验证、安装、启动、
  实际呈现分别有回执。连接丢失时先协调既有请求身份，保留结果不明的变更。

[组件指导](skills/wishos/SKILL.md) · [应用检查单](skills/wishos-applications/references/authoring-checklist.md)
· [公开进度](docs/request-progress-contract.md) · [语音回复](docs/reply-audio-contract.md)
· [输入与排版](docs/input-layout-authoring.md)

## 部署与开发

```sh
npm test
npm run check:cloud
npm run cloud:bundle
npm run package:release
```

[云端部署](docs/cloud-deployment.md)说明如何在自己的 Cloudflare 账号部署配对、OAuth、MCP 和中继。
执行端是本机时可优先走局域网；云端执行的 MCP 请求通过对应中继路由。局域网可达性由真正
执行请求的连接器判断。

[验证说明](docs/validation.md)区分 Host 测试、目标构建、真实 Harness 与设备呈现验收。
[设备链路](docs/device-link-contract.md)、[会话控制](docs/session-control-contract.md)、
[包交付](docs/package-contract-proposal.md)说明版本化接口。

贡献新的接入适配器时，声明实际能力，保留请求身份、完成回执与资源释放语义，并补相应行为测试。
终端驱动、设备接线和出厂 UI 的贡献请提交到 WishOS 仓库。

## 数据与许可

用户主机保存本机配置、授权引用、回执和显式暂存的资源。公开中继保存配对、范围受限的授权、
有界交付回执及临时资源。诊断输出避免包含语音、提示词、密钥和用户文件内容。
TLS 在服务端端点终止，部署时请按实际网络与信任边界配置。

本仓库采用 [MIT](LICENSE)。[第三方许可](THIRD_PARTY_NOTICES.md)列出随包依赖与固定参考的许可来源。
