# Runtime-generated UI and behavior

The current build renders an explicitly supported Brookesia JSON UI 0.1.x subset with LVGL 9.3. It loads JSON and assets from the VFS at runtime. Do not require recompiling the firmware for a layout, style, image or behavior update. Do not describe it as full HTML/CSS or full Brookesia support.

## Discover before generating

Call `/sys/ui capabilities`, `/sys/ui fonts`, `/dev/display drivers`, `/sys/storage read`, `/sys/stats read`, and `/sys/config read`. Check writable mounts, quotas, actual memory, display geometry/palette/latency and supported nodes/styles. The present build permits 16 KiB per document, 32 nodes, 8 levels; future builds may advertise different limits. Unknown capacity or CPU readings remain unknown.

Supported nodes: viewScreen, container, label, button, image, qrcode. Absolute placement and row/column flex layouts are available. Styles cover colors, text alignment, padding per side, corner radius, borders, background/image opacity and registered fonts. Unsupported styles/layouts fail explicitly. The button node describes appearance; hardware button actions belong to rules or the application program.

## Prepare images for bounded rendering

Small PNG and supported baseline JPEG can be decoded locally. Read the current `png_decode_budget_bytes` policy for both encoded-file and decoded-RGBA admission; it is not one fixed limit across devices. Do not send a large PNG and assume streaming transport makes the decoder streaming.

Compile small icons and UI assets with `tools/compile_os_image.py`; it uses Resvg/Pillow and produces standard LVGL RGB565 or RGB565A8. The MCU reads regions without holding a full RGB frame. On the current E6 backend, a full-screen LVGL binary read from SD takes many tiny file accesses; prepare a complete large photo/page on the host in the advertised native frame format and present the file with `/dev/display present`, or stream that frame with begin/chunk/commit. First create and activate a surface with `/sys/ui create` and `/sys/ui activate {view_id}`; pass that `view_id` to presentation admission. The stock E6 six-color native frame is 172800 bytes and is read sequentially in 30 stripes. Other E6 profiles use different formats and replay requirements; read [E6 display profiles](e6-display.md). This advice follows the discovered display format; other display backends may differ. Current firmware does not claim general on-device SVG parsing.

Store reusable small UI assets on SD or another advertised file provider. A full native frame can also reside on SD for repeated display; the device reads it in large sequential blocks. Without a suitable provider, choose a driver advertising streaming, render the composition on the host and use begin/chunk/commit. The compound E6 profiles currently need replayable UI/scene/file input. This path does not write Flash. Do not persist routine image refreshes to internal Flash.

正常 UI 使用完整的字体文件，不按页面文本裁剪字符子集。`style.font` 可以是完整 TrueType 文件的相对／绝对 VFS 路径，例如 `../fonts/Regular.ttf`；也可通过 `/sys/ui font_register {id,file}` 注册一个可缩放字体族，再在不同节点选择字号。当前实现支持 8～96 的整数字号，仍须读取设备声明。字体按需读取并缓存当前字形，不把整份字库装进 RAM。

`/sys/config` 的系统级 `/sys/ui.font_file` 选择默认字体，下一次 UI 准备时生效。应用自己的字体优先写在页面样式里，不为单个应用修改全局默认。默认字体应放在跨应用可用的共享位置；按存储能力选择 Flash 或 SD，不把芯片标称 Flash 容量当作文件系统可用空间。完整字体文件仍只覆盖其原始 cmap；用 `/sys/ui validate` 核对实际文字。缺字必须报错，或由应用明确选择替换，不能靠补当前页面字符来掩盖不完整字库。

NMF1 索引单色字体仍可通过 `{id,file,size}` 注册，用于明确选择的预生成像素字体；只有文件里实际包含的字号／字符可用。字体文件受 VFS 读租约保护，在当前视图使用时不能就地覆盖或注销。更新字体和应用一样发布新文件版本。编入固件的小字表仅作恢复回退，不是正常应用的中文字库。


## Publish and navigate

1. Upload to a fresh version directory, including relative assets, using `/fs mkdir` and bounded `/fs write` chunks. The file writer accepts hex or UTF-8 text, at most 1024 bytes per request. Offset is a decimal string.
2. Only after all files succeed, `/sys/ui open {path,history:"replace",driver}` returns a `view_id` and model revision. Choose an advertised driver. Driver selection is per presentation, not a global restriction.
3. A submitted presentation also returns `job_id`; if admission is deferred, inspect the view and its `scheduled_revision/job_id`. Queued, rendered and physically presented are distinct. Read the presentation manager's `last_presented_view/revision` and the driver's current BUSY state separately.
4. `update {view_id,values,...}` changes a specific view without activating it. Use it for timers and data subscriptions. `activate {view_id}` and `back` change foreground navigation. `refresh` reloads the current view without pushing history; `back` restores its stored values/focus/rotation. Arbitrary form/query/anchor semantics remain application state.

`Client.publish_ui` in `tools/os_client.py` implements version-directory upload then open. Interrupted uploads are not published; partial directories may be removed later. Do not overwrite files held by an active rendering lease.

## Dynamic behaviors

`/sys/ui app_load {file}` loads a `notes-app/1` manifest containing `entry`, optional `policy_scope` (string, e.g. `app:reading`) and `bindings`. It replaces only the application's rule group. It returns entry but does not implicitly start scripts or navigate.

`/sys/runtime load {file,memory_bytes,instruction_budget}` loads Lua 5.4.8 source. Module loading must not invoke system operations: put them in `on_start()` or `on_event(e)`. Available primitives are `notes.call`, `notes.subscribe`, `notes.encode`, `notes.decode`, and bounded logging. No native GPIO, filesystem bypass, arbitrary shared-library loading or user-installed metatables/finalizers are exposed. Native library call duration is not an instruction-counter guarantee.

```lua
function on_start()
  notes.on('/dev/buttons','press',function(e)
    if e.data.button=='C' then notes.call('/sys/ui','refresh');return true end
  end)
end
```

A true result consumes the event; otherwise static rules may also run. Use an empty manifest bindings list when the script owns all button behavior, to avoid duplicate actions. Loading/stopping a script does not retroactively cancel hardware jobs it already submitted.

Lua memory and instruction budgets protect other work; exhaustion faults that application. The default VM ceiling comes from `/sys/resources default_vm_memory_bytes`; individual instances can request another admitted ceiling. This is resource policy, not a fixed application partition. The default instruction budget is 20000 per callback, separately configurable. These limits do not bound every native system call's wall time. Use asynchronous jobs and completion events for network/display operations.

Input during display busy is an independent policy (`dispatch`, `queue`, `drop` for configured sources). A script can request another presentation, but can never bypass the screen driver's readiness gate. No setting interrupts an active E6 refresh. Rules, queues and recording behavior remain configurable rather than tied to a particular sample UI.

The E6 factory suite shares responsive JSON layouts between portrait and landscape,
ordinary Lua entry/modules and small indexed icons. It provides welcome/AP/offline
choices, menu, Wi-Fi/IP/MAC, service configuration summary, SD listing/mount,
power/memory state, recording state, sleep and a Chinese/English selection. Service
configuration is available through the package's management webpage. Voice requires
an explicitly configured upstream route; a saved URL is not proof of a working
Harness connection. Background state changes update the suite's view without
stealing another application's foreground. Sleep waits for its own view revision's
physical completion, including deferred queue admission.

## Presentation and pointer input

`open`/`update` validate the document schema and enqueue the desired presentation.
Font/image preparation belongs to the display job, and may wait for native resources.
Use the declared completion callback; acceptance does not mean pixels were presented.
The selected display exposes `prepare_timeout_ms`; resource waits end with a failure
receipt, and an already active hardware refresh is never interrupted.

Use `/sys/ui hit_test {view_id,x,y}` with the input adapter's physical coordinates.
It returns `ids` in foreground hit order plus the actually displayed `revision`.
Geometry is retained until native completion, including during animations. After
changing a page's layout, ignore hits for earlier revisions; same-layout value
updates can continue to use visible controls. Do not duplicate layout rectangles
in application input handlers.

`values` replaces the complete view model. Keep and merge the application's model
before submitting an update. Label text and image sources can both use node IDs as
value keys; image-source updates are suitable for SVG-derived compressed animation
frames. Keep loading indeterminate unless real progress is known; animate success
only after completion.

Where advertised, `/sys/ui.font_cache_glyphs` is a system configuration applied
on the next frame preparation. It controls an optimization, not font coverage or
allowed text. Defaults come from the selected composition; larger caches consume
more managed memory. Native display completion may include adapter-specific
`timings`; discover them on that adapter rather than assuming every screen has
layout/raster/transfer phases or the S3's measured latency.

## Layout acceptance

- Use flex `mainAlign` / `crossAlign` (`start`, `center`, `end`) for aligned control groups. `placement.width/height:"content"` requests intrinsic size.
- A font can have large asymmetric leading. Single-line labels can select `labelProps.metrics:"ink"` for an intrinsic glyph-ink height, then align the group; do not guess vertical padding from fontSize. Paragraphs retain font line metrics; `style.lineHeight` sets their line advance in pixels.
- Check actual rendered text and icon centers, shared header baselines/padding, localized text, truncation and empty/loading/error states. Button bounds alone are insufficient.
- Use `labelProps.longMode:"ellipsis"` for bounded lists and a detail view for full names; preserve file type/size and directory navigation. Do not load an entire book to show a file row.
- Read application manifest `icon` (resolved relative to its manifest); use a generic fallback when absent, not a hardcoded app-ID-to-icon map.
- Use page Back for the current navigation hierarchy; explain the independent protected Home gesture. A settings confirmation is ordinary application content, never a special renderer page.
- `qrcode` nodes accept `qrcodeProps.text` or a model string keyed by node id. Keep a quiet area around the code and verify the actual raster decodes to the current reachable LAN URL.
