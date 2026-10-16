# Hardware packages

The repository contains system code and optional adapter/application packages.
The following source areas are selected together for a firmware target; their
presence in one repository does not make drivers or factory applications part of
the WishOS kernel:

| Location | Responsibility |
|---|---|
| `firmware/WishOS/src/` | Shared runtime, registry, scheduling, presentation, VFS and resource policy |
| `hardware/agent-os/drivers/` | Reusable device/protocol engines and SDK adapters; native limits and dependencies |
| `hardware/agent-os/platforms/` | MCU/SDK/toolchain capabilities; no assumed device peripheral set |
| `hardware/agent-os/compositions/` + `boards/` | A particular device design: native composition/lifecycle, pins, topology, partitions and resource defaults |
| `hardware/agent-os/runtime/` | Replaceable initial UI, input behavior and startup references, selected by each board |

Runtime applications never edit a pin map, load native code, create RTOS tasks or
access registers. A native hardware change is compiled; a page or interaction
change can be loaded through existing runtime interfaces without recompiling.

Build the existing board:

```sh
WISHOS_BOARD=e6-nova-c6 tools/build_wishos.sh
```

Copy that board directory to make a wiring/UI variant. Select its MCU `platform`, reuse its native `composition` when the topology matches,
then edit `board.json` and select its `runtime` package, then select the directory
with `WISHOS_BOARD=/path/to/my-board`. This changes the generated sketch only;
it never edits core source. `python3 tools/prepare_board_package.py /path/to/my-board`
validates the package before compiling. Pin conflicts, unavailable pins, required
wake/ADC capabilities, missing startup assets and unsupported geometry fail early.
Electrical correctness still requires schematic review; passing this check is not
PCB validation. GPIO8/9 strap loading, USB hardware pins, shared power polarity,
crystal and peripheral voltage assumptions remain native-port responsibilities.

The initial runtime package is an ordinary application reference, with no special
execution layer or privileges. `runtime` links to a directory with `package.json` (`notes-runtime-package/1`). Its
`assets` maps package paths to normal LittleFS files below `/storage/flash/factory`.
The build produces a separate initial filesystem image and verifies every file by
unpacking it. UI, application code and browser controls are writable files, with
leases while executing or presenting. `/system` retains immutable metadata, standard
Lua modules and a small ordinary recovery application. Do not flash the initial
filesystem image over an existing installation during an ordinary firmware update. `/defaults.json` is a
normal `Policies` restore snapshot, not an unchecked bypass; saved settings override
package defaults. `/applications.json` selects ordinary launcher and voice application descriptors and their initial catalog. The application manager owns boot/activation selection. A descriptor's `memory_bytes` is an optional VM ceiling, not a preallocated partition.
The E6 suite requests 81920 bytes; other applications retain the system default.
Its measured 64-bit host startup peak is about 63 KiB; device use differs.
The E6 package's entrypoint loads its UI manifest and opens its entry through public
resource calls. There is no independent native factory-UI boot step. `/sys/apps configure` selects installed launcher/voice references. The low-level runtime resource can load/restart/stop a transient script, but does not create another boot-selection authority. Package files may reside on any suitable VFS provider. Factory packages publish their source repository/path and user help; replacing the launcher uses the same loading and resource interfaces as any other application.

A chip model is not a device model. Two devices using ESP32-C6FH4 can have
unrelated displays, input devices, pin assignments, power circuits and startup UIs.
The platform does not select E6, an IMU, three buttons, a microphone or an SD slot.

A device's `board.json` independently references:

- `platform`: MCU family/SDK target, supported chip variants and silicon GPIO facts.
- `composition`: compiled native service/driver instances and initialization, bus,
  power and error-recovery coordination for that device topology.
- `pins` and `hardware`: wiring and electrical parameters for that composition.
- `flash_bytes`, `fqbn`, `partition_file`, `application_bytes`: Flash capacity (minimum 4 MiB) and executable budget; partitions are checked before staging.
- `runtime_filesystem`: LittleFS partition, mount and factory directory.
- `application_providers`: default volumes for user-installed applications; system configuration may change this policy at runtime.
- `runtime`: its initial UI/interaction package, independent of MCU and drivers.

A new design using an existing MCU reuses its platform and the applicable drivers.
When its peripheral combination differs, add a native `composition.json` and entry
implementing `notesos::begin/poll` and registering the actual resource instances.
When only wiring/electrical parameters or initial UI differ, reuse the composition
and change the device manifest. A new MCU needs a platform adapter and validated
SDK/toolchain support; it does not require a new copy of the portable kernel.

The native composition declares required signals, device-specific constraints,
geometry and optional compiled drivers. The platform supplies silicon GPIO facts;
it does not prescribe the signal names or application behavior. Only selected
native sources are staged under `src/selected` and `src/drivers`. A driver may
provide a trusted native build hook; see the [contribution contract](drivers/README.md).

`compositions/agentic-notes-e6` describes our particular Notes design, not all C6
hardware. Its implemented panel backend is E6; the PCB name does not imply a Nova
adapter exists. Touch, codecs, cameras, six-axis sensors, different button counts
and other combinations can register their own resources through the same kernel.
The same-MCU/different-topology host fixture verifies that unrelated hardware and
UI can be selected without inheriting the E6 device's pins, drivers or CI build scope.
It is a schema/build-selection test, not an implemented or validated LCD product.

The current device compositions use FreeRTOS: native capture/storage/network tasks, serialized
resource dispatch and optional isolated compute workers. On an SMP port, workers
can request an allowed core through `/sys/workers`; drivers/RTOS own scheduling and
bus locks. No application sets task priority above system work or touches a shared
peripheral concurrently. Lua memory/instruction limits contain application faults;
this is not an MMU sandbox against bugs in trusted C/C++ drivers or the SDK.

`e6-nova-c6` is the product board package. `esp32-c3-runtime` is a headless development-board port using the same kernel, VM, worker, Wi-Fi, VFS and NFS implementations; it declares no absent display/audio devices. Other devices need a
native port, independently compiled and validated on that hardware. A common OS
source tree/API is portable; a C6 binary cannot be flashed onto C3/S3 unchanged.
Use the generated sketch under `build/wishos/<board>/sketch/WishOS` in Arduino IDE.
The build command never flashes a device or copies a reference project's firmware.

The presentation service implements navigation state, view revisions and frame
ordering together with the display adapter. This system coordination may be tightly
integrated; the application chooses what to display, when to navigate and which
supported presentation behavior to request. Background document updates do not
navigate. Binary drawing also uses an explicit surface context. Page definitions,
input meanings and UI flow stay in runtime-loadable user packages. The factory suite
provides a starting experience through the same interfaces, with no built-in page
names or button-to-action rules required by the native services.

VM memory ceilings are configurable resource policy, not fixed RAM partitions.
A package may request a ceiling; otherwise the system default applies. Admission
uses physical headroom, system reserve and shared commitments.

## Resource placement and factory suite

`resources` supplies native startup defaults: `memory_limit_bytes` (null = actual
registered heap capacities), `heap_reserve_bytes`, `external_heap_reserve_bytes`,
`application_memory` (`auto`, `internal`, `external`) and `default_vm_memory_bytes`.
The ESP adapter registers separate internal and PSRAM heaps with matching allocation
callbacks. Auto tries PSRAM for a new VM when available; that VM stays on its chosen
heap. Fixed external placement fails if unavailable. RAM files explicitly use
internal memory; PSRAM files use external memory. NFS and lossless display caches
allocate on demand through the same resource manager. Native task/DMA requirements
remain internal. SDK-owned allocations are reflected in physical heap readings;
they are not all individually tracked by the OS.

The current E6 package targets the manufactured board with the 5 V-controlled
battery ADC clamp enabled. The driver conditions the switching/recovery interval;
applications consume `external_power` and valid battery readings through the common
capability/event interface. External power does not mean charge completion.

`runtime/e6-suite/assets/suite/config.lua` selects pages, display profiles, button roles, timer,
rotation and the optional voice route. `assets/suite/main.lua` implements those
choices through public resource calls. `assets/ui/` has portrait/landscape pages;
small indexed icons are streamed from the VFS. Copy the suite to a writable provider
and change the startup reference to replace it without rebuilding. The runtime files are the maintained source. `tools/compile_os_font.py` compiles
extension fonts; it does not overwrite page layouts or the runtime manifest. See the agent's
[display guide](../../skills/agentic-notes-hardware/references/e6-display.md).

Host asset compiler dependencies are pinned in `requirements-os-assets.txt`.
The packaged native font was compiled from Noto Sans SC Regular, source SHA256
`2fa4a4c87f663273cc6e4c854ab7e145671c2e645a9326f61a01cbf8e767eb82`;
the source is provided via `--font` and the SIL OFL is included next to the compiled
subset. Ordinary firmware builds use the checked-in subset and do not need Python
font dependencies or any private research workspace.

## Display adapter boundary

The portable `DisplayScheduler.h` supplies request ownership, queue policy,
view/revision filtering and completion receipts. Its request type extends
`DisplayRequest`; it deliberately has no frame size, color table, BUSY GPIO or
refresh timer. Native adapters implement the small compile-time contract documented
at the top of that header. They report transport, controller or frame-latch completion
rather than guessing from elapsed time. Driver callbacks set flags or queue native
notifications; the service loop delivers application events.

Admission distinguishes accepted work, temporary queue backpressure and rejection.
The UI retries only backpressure; policy rejection or a failed native device ends
the corresponding application request with a failure callback. Adapter `readiness()`
distinguishes a temporarily unavailable device from one requiring recovery. A fault
settles queued requests without starting another hardware transfer. It never makes
an in-progress DMA transfer or EPD refresh interruptible.

The E6 engine, fixed profiles and palettes reside in
`hardware/agent-os/drivers/e6/`. The C6 package binds those engines to GPIO/SPI,
file/scene/UI sources and power in `compositions/agentic-notes-e6/E6Display.inc` and
`E6UiSurface.inc`. All E6 profiles share one scheduler and one physical resource.
The native binding also provides `displayInputBusy()`; the shared input policy
uses that state without referencing an E6 phase or GPIO.
The LVGL renderer reads geometry from the selected board package and emits RGB565
regions; each native sink performs its own packing/rotation/transport. It is not
required to use E6's column bands or keep a full frame in RAM.
Portable text rendering lives in `firmware/WishOS/src/display/NativeText.*` and
has no E6 dependency. The six-color scene codec, native column layout and legacy
scene drawing live in the selected E6 driver under `drivers/e6/scene/`.

To port another screen, implement/compose its native engine and binding in a new
port, describe its actual profiles/formats/completion conditions, and select that
composition from `board.json` when compiling. No hot driver loading or runtime GPIO editing
is provided. The portable Core, scheduler and runtime application ABI remain the
same. The binding must retain buffers until native I/O has finished reading them;
continuous scanout buffers remain owned by the driver after a presentation receipt.
All physical bus operations use that port's arbiter, with DMA transfers holding their
bus lease only as long as the transfer needs it. An independent EPD optical cycle
does not hold SPI. Recovery and power-down remain native lifecycle operations.

The public [display interface](../../skills/agentic-notes-hardware/references/display-interface.md)
describes event evidence and the distinction between a hardware component and its
presentation profiles. Host fixtures cover immediate transfer, DMA, EPD BUSY and
frame-latched continuous scanout with the same scheduler. Actual non-E6 panel
implementations are future adapters, not hidden capabilities of the E6 build.

Compiled component and asset limits belong to each `composition.json`. A board's optional
`drivers` selects only components admitted by its native composition. For example,
the C6 package selects a pinned WakeNet9s component; another port does not inherit
that choice automatically. `asset_file_limit_bytes` and `asset_budget_bytes` are
build admission limits, separate from application VM memory. Asset entries may
reference `@runtime/` files in the common runtime library tree; the resulting bytes
and hashes are included in the hardware package like local assets.

`references/` contains source-backed compatibility targets, not executable board
packages. The SZPI reference adds multichannel capture with a playback-reference
channel, six-axis sensing, camera frames, touch, SDMMC and private I/O-expander
dependencies. SparkBot adds a separate UART-connected actuator controller. These
use the open resource registry; their application workflows are not kernel modes.

## One repository, selected-device builds

`tools/wishos_catalog.py` discovers `boards/*/board.json`; no static CI device
list needs editing for a new board. The same graph drives the local builder and
`.github/workflows/firmware.yml`:

- Board or board-only runtime changes build that board.
- A device composition, MCU platform, reusable driver or shared runtime asset builds its consumers.
- Portable kernel/build dependency changes build all affected targets.
- Documentation/reference-only changes run host checks without firmware builds.
- Workflow dispatch accepts one board id, or `all`; a new board PR needs only its
  target when it does not change shared code.

Arduino CLI/core and libraries are locked in `tools/dependencies/arduino.json`.
The builder downloads/verifies snapshots rather than selecting whichever library
is currently installed. Reviewed LVGL/SdFat changes apply to build-local copies;
ESP32NFS and speech archives retain their separate pinned manifests.

```sh
python3 tools/wishos_catalog.py --changed hardware/agent-os/boards/my-board/board.json
python3 tools/prepare_arduino.py --install-core
python3 tools/build_wishos.py --board esp32-c3-runtime
python3 tools/release_wishos.py build/wishos/esp32-c3-runtime/firmware --output build/release/esp32-c3-runtime.zip
```

Each artifact includes the board/MCU, selected drivers, source/dependency hashes,
partition table and compiler-generated flashing addresses. The workflow uploads
separate archives; an optional dispatch version creates a **draft** release after
host checks and selected builds pass. It never flashes hardware. Compilation does
not promote a reference board to validated support. Physical acceptance and source/
data redistribution rights remain separate; see the E6 driver's provenance note.

Optional sampled-device adapters and their integration contract are documented in
[the sensor driver guide](drivers/sensor-sampling/README.md). Their instance names
and physical composition are selected by each device, not inferred from C3/C6/S3.

Hardware fields are declared by the selected composition in `hardware_schema`.
Types, numeric ranges and enumerated choices belong to that schema; zero, negative
offsets, strings and structured JSON are not rejected by an OS-wide positive-number
rule. `HARDWARE_JSON` preserves structured values for native composition. Scalar
constants are generated for convenience. Intentional signal aliases use explicit
`shared_pin_groups`; undeclared pin collisions remain errors.

Runtime packages can list `gzip_assets` for HTML/JS/CSS. The builder retains only deterministic `.gz` assets in the image; the HTTP adapter sends their encoding and the browser decompresses them. Other runtime files remain directly accessible. `applications.json` carries launcher/voice references, package provenance and device-selected recovery bindings.

Default product images select the implemented feature set for their hardware, including the C6 radio protocols and wake engine. Build-time composition is for port maintainers, not an installation burden for ordinary users. Larger 8/16 MiB devices can declare larger code partitions and writable volumes. `esp32-s3-runtime` is an N16R8 SDK validation target, not a completed Xiaozhi hardware port.
