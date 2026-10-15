---
name: wishos
description: 通过 WishOS MCP 操作设备、显示内容、制作和部署运行时应用。先发现目标设备能力，再调用系统接口；不假定某种芯片必然带有某种外设。
---

先用 `list_devices`、`device_state`、分页 `discover_resources` 和
`describe_resource` 读取实际能力。`get_device_components` 返回所选硬件组成、
驱动和初始包来源；`get_guidance` 或 `wishos://guidance/components` 提供分层指南。
静态指南是参考，当前设备的 schema、资源限制、boot 和配置才是调用依据。

系统负责执行、文件、渲染、呈现和资源协调；应用提供页面、样式、导航、输入含义
和能力调用顺序。Launcher 是普通应用。初始 Launcher 和替代 Launcher 使用相同应用生命周期；可写位置、版本保留和恢复入口以设备包及系统元数据为准。
用户可以安装多个应用，不能封死独立 home/voice 入口。
说明新应用的按键含义、首次使用方法、帮助、任务反馈和返回方式。

本地确定性工作留在设备。应用通过系统 AI 服务请求上游工作；Hub 适配用户选定的
Harness，会话和模型凭据仍归用户的运行环境。MCP 能调用工具不代表它能主动向任意
已有聊天发消息。大网页、JSON/XML、书籍索引和复杂绘图在上游处理，传结果给设备。

资源用 `stage_resource` 分别暂存，轮询 `read_resource_job` 直到完成后取 artifact_id。
`prepare_image` 按明确的目标尺寸和色表处理，不推断屏幕编码。
`deliver_resources` 是传输，不代表显示、安装或启动完成。
应用使用 `prepare_package` → `deploy_package`；修改使用 `update_package` 整文件更新。
先读 `wishos-packages`。应用安装卷以 `/sys/apps describe.install_providers` 为准；
下载目标另读 `/sys/transfers` 策略、卷和配额。普通数据下载不受应用安装卷限制。

设备发起的托管 AI 请求，返回 `wishos-result/2`：只有 application 和 system 两类
有序 action，可以交替，不能预先通过 MCP 执行一次再返回一次。
application 默认发给精确的 origin VM，`wait:processed` 等待应用读取并确认；
`wait:queued` 只确认送达，不能作为替换应用前的处理完成屏障。
显式 `recipient:foreground` 在该步骤解析前台应用。
system 调用已声明资源并等待其原生完成。`{$asset:"相对路径"}` 引用随包资源，
`{$previous:"a/b"}` 引用上一步结构化结果；空路径表示整个结果。
大序列用暂存 JSONL 文件及 `sequence:{path,format:"jsonl"}`，不设固定动作条数，
但每条和控制信封都须符合设备声明的字节预算。

普通 MCP 变更保留 request_id 和 expected_boot_id。响应丢失后查回执并核对状态，
不要重放结果不明的副作用。排队、处理、原生完成和物理效果是不同阶段。
屏幕 BUSY 期间不能发新屏幕命令；录音或输入仍由系统调度及应用策略处理。

直接传输的调用方在原生消费者接管文件租约后释放自己的 transfer_id。
类型化包部署自动完成这段生命周期；托管结果由设备接管和释放，勿另插清理 action。
录音采用独立可解码压缩块，无 SD 时只有短 RAM 缓冲，不隐式写内部 Flash。
不要把提示词、音频、密钥或任意用户文件/日志内容放进遥测。
