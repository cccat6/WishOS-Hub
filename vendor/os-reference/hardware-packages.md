# 设备包与驱动

WishOS 将 MCU 平台、外设驱动、具体设备组合和初始应用分别描述。设备包把它们组合成一份固件，上层应用通过相同的资源接口工作。

| 路径 | 负责内容 |
| --- | --- |
| `platforms/` | MCU、SDK、工具链、芯片引脚能力 |
| `drivers/` | 可复用外设协议、配置与生命周期 |
| `compositions/` | 外设实例、初始化、总线/电源协调、完成回执 |
| `boards/` | 具体接线、分区、内存策略、默认组件和初始应用引用 |
| `runtime/` | 可替换桌面、页面、交互、字体和设置网页 |

## 构建已有设备

```sh
WISHOS_BOARD=lckfb-szpi-esp32s3 tools/build_wishos.sh
WISHOS_BOARD=xingzhi-cube-154tft-wifi tools/build_wishos.sh
```

两台设备的实物验证范围见[设备支持](../../docs/supported-devices.md)。C3/S3无屏配置供运行时与SDK开发使用。

## 新增设备

复制接近的设备包，选择平台，复用适合的外设驱动，再为实际拓扑定义组合。接线不同可以修改 `board.json`；外设初始化或协议不同则提供相应原生驱动。初始应用通过 `runtime` 引用选择。

`board.json` 的主要字段：

- `platform`：MCU/SDK 目标。
- `composition`：原生组件组合和生命周期。
- `pins`、`hardware`：接线、电气参数及驱动配置。
- `flash_bytes`、`partition_file`、`application_bytes`：Flash 与程序分区预算。
- `resources`：默认内存策略，随平台能力使用片内内存或 PSRAM。
- `runtime_filesystem`：文件系统分区、挂载点和初始目录。
- `application_providers`：默认允许安装应用的卷。
- `runtime`：初始应用包路径。
- `release_supported`：是否进入当前正式设备构建清单。

运行 `python3 tools/prepare_board_package.py /path/to/device` 校验包。构建器检查引脚冲突、所需能力、资源引用和分区边界；电气参数由设备设计和实物测量验证。

## 应用与资源

初始套装使用 `notes-runtime-package/1` 清单，将资源路径映射到普通文件。初始 LittleFS 镜像创建后逐文件读回核对。应用、页面和字体按正常 VFS 租约读取，文件更新遵循应用包生命周期。

用户保存的配置覆盖设备默认值；移除覆盖即可恢复继承。显示驱动声明色彩空间、尺寸与完成模型，应用按这些能力布局。按键、触摸和语音入口的初始意义由普通套装和系统配置共同提供。

## 驱动贡献

驱动发布能力描述、参数校验、只读状态、原生操作和完成/失败回调。所有物理总线访问参与仲裁；等待独立外设动作时释放总线。应用退出和资源重配保留原生安全完成边界。

参见[驱动契约](drivers/README.md)、[输入与布局](../../docs/input-and-layout.md)及[贡献指南](../../CONTRIBUTING.md)。新设备应提交目标构建结果，并明确实物测试的外设和配置。
