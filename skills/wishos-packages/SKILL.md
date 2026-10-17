---
name: wishos-packages
description: 构造、预检、安装和整文件更新 WishOS 运行时应用包。用于完整 revision 与资源交付，不用于固件或原生驱动升级。
---

读取目标组件和固定 OS 参考：`get_device_components`、`get_guidance`（packages）。
包格式以目标声明为准。当前 wishos-package/1 的 package.json 指向 app descriptor、
files.jsonl 及其 SHA-256。inventory 按 UTF-8 路径排序，记录规范相对路径、十进制字符串
字节数、SHA-256 和可选 kind（json/lua/asset），排除 header 与 inventory 本身。
应用是文本 Lua，不把原生驱动或固件塞进运行时包。

完整文件分别 stage，完成后用 prepare_package / preflight_bundle；deploy_package 安装
并可显式激活，update_package 从指定 catalog/base revision 构造完整新版本。
这些工具返回 job，轮询 read_resource_job。修改以整个文件为单位，不做行号补丁。
未变化的大资源由设备按租约复制并校验摘要；上游读取未变化的控制源码做完整预检。
书籍、录音和用户文档放在应用 revision 目录之外。

预检实际编译 Lua 5.4 源码，验证 header/inventory/hash、静态引用、已知格式、能力和预算。
大数据 JSON 标记 kind:asset 可按数据流校验；Lua/入口不能靠 asset 标签绕过编译。
父相对路径可在包内部使用，不能逃出 revision。系统资源只引用规范的 /system 路径。
UI 预检按所选 renderer 的词汇和限制；on_start 可注册字体，结构有效不代表字体已就绪。
预检不执行 on_start、不证明任意程序语义、不预留 heap，也不保证之后一定能激活。

先读 `/sys/apps describe.install_providers` 确认应用安装卷，再读 `/sys/transfers` 有序目标、
`/fs mounts` 和配额；mounts 按 next_cursor 连续读取到 more:false，不能只看第一页。
显式交付按有序目标中实际可用的提供者处理容量；free_needs_refresh 不代表应改用下一个卷。
通过该提供者声明的 capacity_refresh 执行容量刷新，异步方法等真实完成并释放 operation，
之后重读策略和卷元数据；不要固定刷新 /dev/flash 来代替当前 SD／其它卷。
Hub 交付工具负责这一准备流程。begin 明确返回前效容量／准备拒绝时仅作有界恢复，
不把空间不足、未知响应或变更超时当作换卷／盲重试许可；检查原请求及阶段回执。
用户应用/替代 Launcher 优先按设备包的 SD 策略放置；只有设备明确
允许且配置了内部 Flash 目标和配额才能回退，不按 MCU 型号或容量猜测。
install_providers 是系统可配置策略：新设备返回 provider ID 数组，空数组禁止用户安装；旧固件 CSV 仍可读取。
通过 system `/sys/apps configure {install_providers:[...],persist:true}` 修改，需遵守原生对
现有应用引用、provider 可写性和 pending 的整体验证；不是编译期硬件禁令。
4MB 设备默认 SD，系统操作可明确允许 Flash；下载目标、优先级和配额另行配置。
初始 Launcher 与用户应用同层，也是可管理文件系统中的目录包；更新仍使用新 revision、
租约和索引切换。设备包的初始引用不等于开放该卷的用户安装权限。具体位置从 factory_launcher 和卷元数据读取。
`/system` 系统元数据、标准 helper 和恢复资源不属于可写应用目录。普通数据下载仍按下载策略。

传完后提交原生 validate，等待成功票据，再以匹配的 validation_id、manifest/package
和 expected_revision 安装。持有验证租约直到 catalog 提交；成功安装消费票据，失败释放。
激活是独立动作。安装成功、激活失败时仍须保留已提交 revision 和各阶段回执，不能说回滚了。
旧 revision 与运行中文件由正常租约/保留规则保护。

类型化部署在原生消费者取得租约后释放自己的传输回执。
普通 deliver_resources 留给调用方显式接管/释放；托管结果由 OS 接管，勿加重复清理步骤。
通过托管结果安装时返回以下连续动作及对应 files，不预先执行：

```json
{"format":"wishos-result/2","actions":[
 {"type":"system","path":"/sys/apps","method":"validate","args":{"manifest":{"$asset":"app.json"},"package":{"$asset":"package.json"}}},
 {"type":"system","path":"/sys/apps","method":"install","args":{"manifest":{"$asset":"app.json"},"package":{"$asset":"package.json"},"validation_id":{"$previous":"operation_id"},"expected_revision":{"$previous":"revision"}}},
 {"type":"system","path":"/sys/apps","method":"launch","args":{"id":{"$previous":"application_id"}}}
]}
```

`$previous` 是上一步结果；不能插入额外步骤改变引用含义。应用通知可在其它位置显式安排，
替换前需处理完成屏障时用 wait:processed，而非 queued。大动作计划使用单独 JSONL。

默认保留当前 VM。只有显式 `stop_current_before_transfer:true` 且 activate:true，Hub 才在
完整预检、boot/revision/方法确认且没有应用切换 pending 后停止当前运行时。
停止前再次核对，停止后确认没有新的 pending、运行 VM 或 catalog 变化再进入传输。
runtime.stop 只停止当前 VM，不取消应用切换；遇到并发变化则保留回执、拒绝继续，
不替用户取消切换或再次停止。已 available 的卷直接使用，不重复调用其 prepare/mount。
之后失败可能留下已停止的 VM 或已安装
但未激活的新版本；检查回执，不隐式重启、降准入要求、自动回滚或改写托管动作。

只读预检可在同 boot 的有界窗口恢复；变更只有被证明尚未发出才可重试。
响应 result.not_dispatched:true 是本次未发出的失败，不撤销之前阶段。
已发送而结果不明的变更先核对回执、boot 与 catalog，不能重放。
拒绝时保留旧包，失败候选由显式清理处理，不删除正在运行的版本。
