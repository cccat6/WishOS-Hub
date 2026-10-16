# Runtime-generated UI and behavior

The current build renders an explicitly supported Brookesia JSON UI 0.1.x subset with LVGL 9.3. It loads JSON and assets from the VFS at runtime. Do not require recompiling the firmware for a layout, style, image or behavior update. Do not describe it as full HTML/CSS or full Brookesia support.

## Discover before generating

Call `/sys/ui capabilities`, `/sys/ui fonts`, `/dev/display drivers`, `/sys/storage read`, `/sys/stats read`, and `/sys/config read`. Check writable mounts, quotas, actual memory, display geometry/palette/latency and supported nodes/styles. The present build permits 16 KiB per document, 32 nodes, 8 levels; future builds may advertise different limits. Unknown capacity or CPU readings remain unknown.

Supported nodes: viewScreen, container, label, button, image. Absolute placement and row/column flex layouts are available. Styles cover colors, text alignment, padding per side, corner radius, borders, background/image opacity and registered fonts. Unsupported styles/layouts fail explicitly. The button node describes appearance; hardware button actions belong to rules or the application program.

## Prepare images for bounded rendering

Small PNG and supported baseline JPEG can be decoded locally. The PNG encoded-file and decoded-RGBA limits are each 16 KiB. Do not send a large PNG and assume streaming transport makes the decoder streaming.

Compile small icons and UI assets with `tools/compile_os_image.py`; it uses Resvg/Pillow and produces standard LVGL RGB565 or RGB565A8. The MCU reads regions without holding a full RGB frame. On the current E6 backend, a full-screen LVGL binary read from SD takes many tiny file accesses; prepare a complete large photo/page on the host in the advertised native frame format and present the file with `/dev/display present`, or stream that frame with begin/chunk/commit. First create and activate a surface with `/sys/ui create` and `/sys/ui activate {view_id}`; pass that `view_id` to presentation admission. The stock E6 six-color native frame is 172800 bytes and is read sequentially in 30 stripes. Other E6 profiles use different formats and replay requirements; read [E6 display profiles](e6-display.md). This advice follows the discovered display format; other display backends may differ. Current firmware does not claim general on-device SVG parsing.

Store reusable small UI assets on SD or another advertised file provider. A full native frame can also reside on SD for repeated display; the device reads it in large sequential blocks. Without a suitable provider, choose a driver advertising streaming, render the composition on the host and use begin/chunk/commit. The compound E6 profiles currently need replayable UI/scene/file input. This path does not write Flash. Do not persist routine image refreshes to internal Flash.

For extended fonts, use `/sys/ui font_register` with `{id,file,size}`. The current backend reads indexed NMF1 monochrome glyphs from VFS, with at most 1152 bytes of bitmap scratch and four registration slots. Compile chosen sizes from an OpenType/TrueType source using `tools/compile_os_font.py --format nmf --sizes 20,24,32`; the device does not execute an unrestricted TrueType outline parser. Registered font files are read-leased until `/sys/ui font_unregister {id,size}`; unregister is refused while the current UI uses that font. Publish a new file version before registering a replacement. Built-in fonts support only their advertised sizes and glyph set. Missing glyphs must not silently turn into blank text.

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
