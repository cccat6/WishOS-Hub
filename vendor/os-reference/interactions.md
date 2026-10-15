# Interaction applications

Discover device instances first. Button names, sensors and display drivers belong
to the selected hardware package. The C6 package below is an example, not an OS
requirement. Native code recognizes input; runtime application files decide its
meaning. A one-button port can use the same gesture/application contract.

## Buttons

`/dev/buttons describe` declares gesture limits; `read` returns configured and
applied timing per button. `configure` accepts a patch:

```json
{"defaults":{"debounce_ms":25,"long_press_ms":800,"click_window_ms":300,"max_clicks":3,"repeat_ms":0},"buttons":{"A":{"long_press_ms":1200}},"persist":true}
```

`press` and `release` are immediate after debounce. `long_press` occurs while
held; optional `repeat` follows at its own interval. `click` carries `count` and
waits for the interval or configured maximum count. A long press cancels the
pending click sequence; do not also map `release` to a short-click action.
`gesture_id`, `captured_at_ms`, `presentation_id`, `held_ms` and `long` identify
the originating interaction. Capture the target page at press if release should
act on that page rather than whichever page is currently requested. Changes are
applied at the next gesture; a held key keeps its original timing. Persistence
does not hold the sampling lock.

Input while a display is busy remains `/sys/config` policy under `/sys/input`:
`dispatch`, `queue` or `drop`. This never changes the driver's BUSY invariant.
Queued events retain capture times; dispatch is generally appropriate for
push-to-talk. A delayed release must not stop someone else's recording.

## Pages and presentations

`/sys/ui open` accepts `path`, `driver`, `history`, `values`, `focus`, `hidden`
and `rotation`. `values` is a bounded map from label ids to strings. `focus` is
a node id to outline; `hidden` is a list of node ids. Rotation is 0/90/180/270.
These parameters are copied into the queued presentation: later navigation
cannot change a frame already being rendered. `refresh` retains current values
and navigation history; opening/back resolve files afresh. Navigation retains each document model, including label values, focus and rotation.
Additional application state stays in the runtime or its files.

Portrait and landscape may use different documents. Rendering uses the logical
dimensions and the adapter maps them to panel coordinates. Fonts outside the
small built-in glyph set require a registered font; a label may explicitly set
`labelProps.missingGlyph: "replace"` for fallback question marks. Substitution
counts are observable. Applications choose fallback behavior explicitly; it is not a universal
replacement policy.

Select a display driver for each presentation or transition. This panel applies
one driver to a whole physical refresh, not simultaneous independent waveforms
to individual widgets. A future partial-update display advertises its own
region support. Estimated latency is a driver property, not a promised UI delay.
The presentation manager keeps view revisions and navigation state. Pending,
rendered and physically completed states are different. Background model updates
never change the foreground selection.

## IMU and time

`/dev/imu configure` takes `settings` and optional `persist`. Orientation uses
`orientation`, `sample_ms`, `stable_ms`, `dominance` and `rotation_offset`.
It emits stable `orientation {rotation}` events; flat/ambiguous poses preserve
the previous direction. `auto_rotate` is an application choice.

The SC7A20H adapter also supports its hardware click engine: `tap`, `tap_count`
, `tap_window_ms`, `tap_threshold1_mg` and `tap_threshold2_mg`, emitting `tap {count}`. The driver schema exposes exact
supported timing, not approximate values: 100 + 320*n ms, n=0..15 at 200 Hz.
Motion wake and tap sensing are distinct from rotating a UI. Housing-dependent
tap recognition and axis orientation still require physical verification.
Register definitions follow the manufacturer's [SC7A20H v0.7 specification](https://cdn.semikey.com/upload/pdfs/b9/a9/b9a93bbfbba7045f8bf2e712639cbf61.pdf).

`/services/time configure` takes `settings` with `enabled`, `servers`,
`interval_ms`, `retry_ms`, `timeout_ms`, plus optional `persist`. `sync` requests
one attempt; offline attempts wait for connectivity without enabling Wi-Fi.
`read` distinguishes scheduled/active/last successful sync and errors. Timers
always use monotonic time, independently of wall-clock corrections. The ESP
adapter uses SDK SNTP callbacks; it does not block waiting for a time response.
Timezone/clock visibility/clock redraw interval are application preferences.

## Layer boundaries

The system exposes input classification, presentation contexts, clocks and resource
control. Menus, recording screens, battery icons, percentage curves, Agent routing
and default button meanings belong to application/hardware-package data. They are
not kernel features, and no new factory application is activated by these changes.

A presentation context represents a view, not a requester priority. `open` creates
and activates a document; `update {view_id,...}` changes that document without
activating it. `activate` and `back` perform navigation. The scheduler submits only
foreground data. Pending frames carry view/revision/activation stamps; old frames
cannot overwrite another foreground context. A waveform that already started must
finish, so desired state and last completed presentation are reported separately.
This rule also applies when both views belong to the same application.

For binary/streamed drawing, `create` returns a surface `view_id`; explicitly
`activate` it before `/dev/display begin/present/scene/clear`. A background surface
cannot submit pixels. It must repaint when reactivated (observe `/sys/ui activated`)
if its pixels are not retained in a document or file. The manager does not silently
cache an entire image or write Flash. `close` and app teardown release contexts;
unfinished hardware work still follows its physical completion rules.

Memory is not partitioned into fixed 64 KiB applications. `/sys/resources` reports
physical free heap, system reserve, shared managed budget and existing reservations.
`default_vm_memory_bytes` is a configurable policy inherited by new instances;
`memory_bytes` is an optional per-instance ceiling. Admission considers all existing
reservations and actual heap headroom. The previous 128 KiB per-VM ceiling was also
removed in favor of this shared policy. Allocations occur on demand within the
admitted ceiling. Native services, UI models and background workers share accounting.
Global resource policy is system-scoped; an app cannot lower the system reserve.

Candidate `on_prepare` can validate files and discover capabilities before the old
runtime is stopped. Failed preparation preserves the running instance. Low memory
must be an explicit admission/allocation result, not a reason to reinterpret an
application's configuration or silently remove capabilities.

## Combined buttons and input timing

The driver exposes a debounced `pressed_mask`, per-button index, raw accepted
`edge_at_ms`, `pressed_at_ms`, observed `captured_at_ms`, gesture identity and held
duration. GPIO bank sampling commits all accepted levels before delivering events;
A+B does not depend on iteration order. Discover the adapter's sampling period.
Debounce, long-press duration, click window and application combination tolerances
are separate settings. Edge time remains the observed edge, not an invented
sub-sampling hardware timestamp.

The ordinary `/system/lib/input.lua` runtime module provides `watch(source,
patterns,callback)`. Patterns support `event`, `button`, `count`, min/max hold,
`with` held-button conditions, unordered `chord.buttons` with a time window,
and ordered `steps` with `after_ms`, `within_ms` and `jitter_ms`. `defer_ms` and
`cancel_pending` let an app postpone a single-key action until a chord window has
closed. `consume` and the callback result determine application event consumption.
No chord has an OS-defined action. The watcher can be stopped/replaced at runtime.
Deferred callbacks carry the original event; re-read button state if the action
requires the key to remain physically held at execution time.

Example: `{id='both',event='press',chord={buttons={'A','B'},window_ms=75},
cancel_pending={'single'}}`. A preceding single-key pattern can use
`defer_ms=100`. Those numbers are application examples, not hardware limits.
