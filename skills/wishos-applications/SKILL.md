---
name: wishos-applications
description: 制作可实时替换的 WishOS Lua/UI 应用，定义页面、样式、导航、按钮行为和回调。通过公开系统能力运行，不修改固件内核。
---

先读取系统和所选驱动指南、当前设备 schema 与默认初始包来源。
每次制作或修改应用，都先读 [应用交付检查单](references/authoring-checklist.md)，
也可用 `get_guidance {component_id:"application-checklist"}`。
交付前逐项核对，记录实现/验证证据或不适用原因；不能以一次静态预检代替行为验收。
重点明确动态值的数据来源、更新触发、精度与失效反馈，依据实际显示配置的延迟和完成模型
选择节奏，不从 LCD/EPD 名称推定策略。细节与通用写法按检查单及相关契约读取。
UI 描述交给系统渲染，应用提供内容和行为；出厂套装也是普通运行时应用。
未显式设置的配置继承系统默认。页面省略 `style.font` 时继承父级／系统；
目标声明支持时，`style.font="system"` 可在自定义字体子树内显式回到系统字体。
普通应用启动不写 `font_file` 或持久化主题默认值；只为用户明确选择保存覆盖。
恢复继承使用目标声明的配置接口与 `inherit`，不把当前默认值复制为覆盖。
用户可在允许的卷安装多个应用及替代 Launcher，默认 Launcher 也是普通目录包；版本切换与文件可写性由系统文件/应用服务管理。
同名应用合法；修改和导航以明确的应用 ID、revision 与资源引用为准，不凭标题猜覆盖目标。
已移除的目录引用不能当作仍可 inspect 的安装项；保留的旧不可变路径可作明确来源，不能就地改写。

源码匹配声明的 Lua 版本，模块和路径通过运行时接口解析。
按设备声明复用标准 helper：`/system/lib/input.lua`、`/system/lib/ai.lua`。
它们在 OS 源库中的路径是 `firmware/WishOS/lib/{input,ai}.lua`；仓库源码路径不是设备 URI，
不要把标准库当作某硬件初始 UI 的文件再次打包。
需要 API 细节时可读 get_guidance 的 input-library / ai-library；返回的是固定版本源码参考，
实际运行仍使用设备声明的标准模块。
能力调用在生命周期/事件回调中执行；预检编译不执行 on_start，不能证明任意程序语义。
在 descriptor 声明需求和预算，并处理原生准入/操作失败。

短长按、多击、组合按键、旋转、录音反馈与显示配置选择属于可修改的应用行为。
不把应用专属页面或流程写入内核。用系统事件和回调协调并发；刷新中不能打断显示驱动。
应用须有简明的输入说明、首次引导、帮助、反馈及返回方式，保留系统独立 home/voice 入口。
语音按当前前台应用是否显式接管 voice_input 路由：声明接管则在原 VM 处理系统的
voice_requested/released；否则由普通默认语音应用处理，并保留原应用／页面 context。
说话可请求翻页、打开应用或操作控件，不局限于制包；按已发现应用合同返回有序
application/system actions，不猜按钮含义、控件 ID 或内核导航命令。Home 与 hold 语音
是独立的保护入口，帮助文本读取目标实际绑定；不要写死“长按两秒回桌面”。

支持字段由目标实时声明。当前版本参考的 dynamic-ui 说明 `labelProps.metrics:"ink"`、
`longMode`、`style.lineHeight`、content 尺寸、flex 对齐、`imageProps.fit` 与 qrcode 节点；
先核对能力再采用，不把新参考当成旧固件的能力。`/sys/ui fonts` 若返回 scalable 系统字体，
按其 minimum_size/maximum_size 使用，不按恢复字库的离散字号猜测。
字号可用不等于字形齐全。目标若声明只读字体覆盖检查，用实际字体／字号及继承关系
检查已知静态文本，报告缺失码点；未提供能力或运行时才绑定的字体不能冒充已检查。
缺字、格式或无效引用等确定性错误，不对相同输入／配置无限重试；保持 Home/voice 可达，
等修复、相关资源变化或显式重试。只有声明的暂时背压才按其契约等待／重试。
应用图标从 manifest 元数据解析；相对路径以所属 manifest 目录为基准。
临时网页会话与退出确认读 applications 指南，通过已声明系统服务实现，不特判 settings 应用。
退出设置后仍需运行的 NFS 等服务按其声明显式选择 system lifetime；普通 owner 资源随实例退出清理。

确定性工作本地执行。通过系统 AI 服务请求推理或上游处理，不自行适配 Harness 协议。
轻量 HTTP/API 可使用系统网络服务；重资源交给上游提炼、渲染或索引后单独传输。
可只交付 UI 资源，无需为一次显示强行安装完整应用。

更新按 wishos-packages 指南替换完整文件，构造不可变完整 revision 并先预检。
安装与激活分开；不覆盖运行中版本、系统资源或旧应用的用户数据。
动态路径无法静态证明时使用正常运行时错误处理，不能声称预检已验证一切。

会话选择、固定 bot 与应用修改请求，先读 `get_guidance {component_id:"session-control"}`。
应用通过系统 AI 服务提交 session_control；Harness 原生运行时拥有会话历史和凭据，
应用只保存会话引用/模式/未完成操作 ID。文字与语音都保留提交时 current/launch_origin
快照和显式 intent，不能根据请求完成时的前台猜修改目标。语音切换旧会话可经 MCP
解析目录引用，再有序交付 selection_action；工具返回不是应用已切换的证明。
