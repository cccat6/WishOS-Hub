# Display components, profiles and completion

One compiled display component serves a display resource such as `/dev/display`.
Its color/latency configurations are **profiles**, selected per presentation.
The existing `driver` request parameter and `drivers` discovery method select/list
these profiles; they do not dynamically load native code. E6's three compound modes
belong to `e6-ist7601`, with two additional stock six-color profiles.

Before rendering, discover the component, geometry, profile input format/byte count,
color space/palette, source access (stream or replay), update capability and latency
estimate. Do not infer a 480×720 panel, six-color pixels, a BUSY pin, full-screen-only
updates or a refresh delay from the generic display interface. Only use methods and
formats declared by the installed adapter. See [E6 profiles](e6-display.md) for the
current board's concrete inputs and recommendations.

Use `/sys/ui open/update` for runtime JSON compositions, or an activated surface and
`/dev/display present` / `begin,chunk,commit` for the declared native input. Raw bytes
must name their profile: they contain no universal pixel-format identifier.
`tools/os_client.py present_native` reads the selected profile's frame size and
stream support instead of assuming E6's encoding. Pixel validity is checked by the
native adapter. A display without streaming must not silently spool to Flash.

All adapters use a terminal `completed` or `failed` event. Use
`notes.request('/sys/ui', 'open', args, fn)` to associate a one-shot completion
function, or `notes.on('/dev/display', {'completed','failed'}, fn)` to observe events.
The request wrapper matches job ID or view ID + revision from the method's async
contract; deferred UI admission needs no manual correlation. See [callbacks](callbacks.md). Events include `owner`,
`activation`, `state`, `success`, `error`, `total_ms`, and `completion.kind/source`.
They are delivered in the system event loop, not by running user code in an ISR.
Intermediate BUSY/ready edges are not whole-job completion: a compound E6 update
can contain several such edges. Use the single terminal receipt for the request.

| `completion.kind` | What the driver has established |
|---|---|
| `transport_complete` | The transfer/copy is complete and source buffers can be reused; no optical/scanout confirmation is implied. |
| `device_ready` | The controller's completion condition has occurred, e.g. E6 BUSY plus power-off completion. |
| `frame_latched` | A driver-confirmed frame boundary or latch switched the submitted frame into scanout. |
| `unchanged` | Previously established content was reused; no new physical refresh occurred. |
| `none` | No successful completion evidence, including failed/superseded/cancelled jobs. |

A successful LCD/OLED API call is not automatically a completed frame. Drivers may
use blocking transfers, DMA completion, TE/VSYNC or controller status. Continuous
RGB panels and multiplexed LED matrices can keep scanning after a request completes;
job completion does not free their persistent scanout buffers or stop refresh.
A timed estimate alone is never upgraded to observed scanout completion.

The common scheduler owns pending requests, latest/FIFO/reject policy, stale queued
views, revisions and terminal disposal. The adapter owns encoding, transfer sizes,
physical timing, bus leases, DMA/source ownership, cancellation points and recovery.
Queued uploads can be cancelled before adapter admission. An E6 stream abort
requested during preparation waits for its safe receive boundary, without sending
commands while BUSY. A successful abort request is not yet its terminal receipt.
The client cleans up failed preparations/uploads; a lost commit response retains
the job/view IDs for inspection rather than assuming rejection.
Newer requests cannot interrupt committed hardware work. E6 waits for BUSY; other
screens do not inherit that electrical requirement. Input handling during an active
presentation remains application/system policy, independently of hardware safety.

UI admission distinguishes temporary queue backpressure from rejection. Backpressure
remains pending; a reject-policy refusal or permanent adapter failure produces the
request's `failed` callback instead of retrying forever. An accepted UI update may
return `status: presentation_rejected` with `admission_error`: the view model was
updated, but no frame was submitted. Explicit refresh or a later update can retry
after the application addresses the cause. Readiness faults also finish previously
queued display jobs without issuing further hardware commands.

Current hardware integration is E6. Immediate, DMA, BUSY and continuous-scanout
completion models are validated using host adapters; this is not a claim that
specific LCD/OLED/LED controllers have already been implemented or physically tested.
