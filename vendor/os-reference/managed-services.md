# System-owned AI, resources and diagnostics

Discover `/services/ai`, `/sys/transfers`, `/sys/logs`, `/sys/telemetry`,
`/services/time` and `/net/proxy`. UI parsing, layout, font/image rendering and
presentation are OS services. UI descriptions, styles and interaction choices are
ordinary runtime assets. A UI-only result does not need a new executable app.

## AI requests and ordered results

Applications call `/services/ai submit {input,request_id?,timeout_ms?}`. No request
or result has a `both` target. The request payload is `wishos-ai/2`; results are
`wishos-result/2` with an ordered `actions` array. Every action has exactly one
of two types: `application` or `system`. They can alternate, including notifications
before and after an application replacement. The system owns the task independently
of its originating VM. Returning Home does not undo already accepted remote work.

A system action is `{type:"system",path,method,args}` using a discovered resource.
It waits for the resource's declared completion. Synchronous acceptance, deferred
configuration and physical completion still mean what that resource advertises.
An application action is `{type:"application",recipient:"origin"|"foreground",
topic,data,wait:"processed"|"queued"}`. Defaults are origin, result and processed.
Origin identifies the exact originating VM; foreground explicitly chooses the
current VM when that step executes. Never silently deliver an old reply to a new VM.

For processed actions, handle the `application_action` hint by reading
`read_action {id,step}`, then `acknowledge {id,step,ok,result?}` after processing.
Only the selected instance can acknowledge. Pending actions remain readable when
the event ring loses a hint. The optional `/system/lib/ai.lua` receiver implements
this subscription plus bounded periodic recovery for ordinary applications:

```lua
local ai=notes.require('/system/lib/ai.lua')
local receiver
function on_start()
  receiver=ai.listen(function(action,done)
    -- Render/read/update application state as appropriate.
    -- Return false for asynchronous handling, then call done(ok, result).
    -- Returning normally acknowledges successful synchronous processing.
    print(action.topic)
  end)
end
function on_stop() if receiver then receiver.stop() end end
```

Queued actions carry small data in the event and advance immediately. They are not
a processing barrier. Do not use queued delivery when replacement must wait for
an application to finish work. A processed acknowledgement also does not prove a
separately queued display refresh finished; wait on the display operation when
that is the desired barrier.

Large resources are staged by the Hub, then transferred with file digests into a
fresh version directory. A result references the verified bundle via top-level
`transfer_id`; `{$asset:"relative/path"}` resolves an argument within that bundle.
`{$previous:"application_id"}` obtains a previous step's object field. For more
complex variables, conditions and loops use the existing runtime application,
not an invented result-script dialect. A UI-only result can call `/sys/ui` without
replacing the application.

For sequences too large for the control envelope, stage `actions.jsonl` (one
action per line) and return `sequence:{path:"actions.jsonl",format:"jsonl"}` instead
of `actions`. The device preflights and reads it incrementally. There is no fixed
step-count limit; the advertised action-size and overall task deadline apply.
Failures stop remaining actions without rolling back completed side effects.
Cancellation waits for an in-flight native operation to end safely. Resume/read
receipts before retrying uncertain mutations; do not replay the entire sequence.

Prepare book indexes and extract large JSON/XML upstream. Full arbitrary XML/HTML
DOM parsing is not a native capability. A host can generate a UI-only document,
processed data, or an application package according to the discovered budget and
formats. Do not assume a six-color screen, particular geometry or PSRAM.

Download policy lists ordered providers and quotas. Internal Flash is allowed only
when explicitly enabled; mounted-full media does not silently redirect downloads.
Recording retention remains separate. Partial files use quota and are cleaned
explicitly; cancellation frees leases, never formats a volume. The Hub can stage
binary output through `POST /api/os/artifacts/upload` without base64 in model output.

## Time, proxy and diagnostics

NTP config includes servers, enabled, interval/retry/timeout and POSIX `timezone`.
UTC is the wall-clock basis. Examples: `UTC0`, `CST-8` (UTC+8),
`EST5EDT,M3.2.0/2,M11.1.0/2`. Monotonic timers are unaffected by timezone changes.
There is no bundled IANA timezone database. NTP uses direct UDP; TCP proxies do not
silently tunnel it. Configure a reachable NTP server or explicitly set wall time.

Proxy modes: direct, HTTP CONNECT, SOCKS5, with optional credentials and exact or
suffix-domain bypass. New connections snapshot settings; existing connections are
not silently reset. HTTP/HTTPS and WS/WSS use the same native clients; TLS still
verifies the origin hostname after tunneling. The raw IPv4 TCP adapter requires an
IPv4 proxy address. UDP/NTP tunneling is not advertised.

Logs use a configurable RAM ring, severity, layer, source, code and timestamp.
They have a per-second rate cap and observable overwrite/suppression. Read with
cursors and optional layer/owner filters. Export through files/network explicitly;
there is no automatic Flash log write. Completion receipts remain separate.

Telemetry is independently configurable: enabled, boot registration, usage, errors,
endpoint, interval and retry. It defaults off. Registration sends device/boot IDs;
aggregate reports contain only counters and independent random deduplication IDs.
No prompts, recordings, URLs, credentials or arbitrary log text. Transport IP can
still be visible to the receiver. Disabling stops telemetry delivery; local diagnostic counters remain independent;
bytes already sent cannot be recalled. Do not claim fatal crashes are guaranteed
to be caught or uploaded before power loss.

Use `/sys/telemetry flush` through its asynchronous completion contract when an
application/power policy explicitly wants a final batch. This does not enable an
opted-out collector. Unsent RAM aggregates may be lost on reset or power loss;
registration counts are not user counts, and reset reasons distinguish wakeups.
AI system work remains active after leaving its originating application unless
explicitly cancelled. Use an install action without a launch action for a background installation; use an application action when that application should decide how to present the result.

Generated binary output can use authenticated Hub
`POST /api/os/artifacts/upload` (`Content-Type: application/octet-stream`).
Stream the file bytes with the Harness execution tool; use the returned artifact
ID in the managed result. Do not put large base64 images into model responses.
Image/HTML rendering, archive extraction and large JSON/XML selection happen in
upstream tools. Inspect target format/geometry/decoder capability before rendering;
no fixed E6 size, palette or framebuffer assumption is valid for all devices.
