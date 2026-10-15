---
name: wishos
description: Build or operate runtime applications, UI and resources on a paired WishOS device through WishOS MCP. Use for device presentation, application installation, inputs and system services; discover each device instead of assuming hardware.
---

Use `list_devices`, `device_state`, paginated `discover_resources`, and
`describe_resource` for the selected resource. A chip family does not define pins,
fonts, storage, sensors, display colors, speed or native completion behavior.

Applications supply pages, styles, navigation, input meanings and runtime calls.
UI parsing/layout/rendering and presentation are system services. The replaceable
launcher is an ordinary app. Read the hardware package's default suite source as
a reference; keep home/voice reachable and explain new controls, first-use help,
feedback and a visible route home. Use resource calls, never native GPIO/RTOS code.

Keep deterministic work local. Applications use the system AI interface for
remote tasks; the Hub delegates to the user's chosen Harness. A remote function
need not invoke a language model. Pre-extract oversized JSON/XML, index books and
prepare heavy resources upstream. Do not make the terminal fetch arbitrary source
URLs or parse a response larger than its discovered budgets.

`stage_resource` returns a job identity, not an artifact immediately. Poll
`read_resource_job`. Stage separate files; reference completed artifact IDs.
`prepare_image` is host-side, with explicit discovered geometry and palette.
`deliver_resources` delivers a verified bundle, not a displayed frame or launched
app. Native packing/encoding is adapter-specific; inspect the display API.

For a managed device request return `wishos-result/2` with ordered `actions`, each
of type `application` or `system`. They may alternate, with no fixed count:

```json
{"format":"wishos-result/2","actions":[
 {"type":"application","recipient":"origin","topic":"prepared","data":{},"wait":"processed"},
 {"type":"system","path":"/sys/apps","method":"install","args":{"manifest":{"$asset":"app.json"}}},
 {"type":"system","path":"/sys/apps","method":"launch","args":{"id":{"$previous":"application_id"}}},
 {"type":"application","recipient":"foreground","topic":"open","data":{}}
],"files":[{"path":"app.json","artifact_id":"completed-staging-id"}]}
```

`origin` is the exact requesting VM. Default `wait:processed` waits for its
application ACK, whereas `queued` proves delivery only. `foreground` explicitly
selects the foreground at that step. `{$previous:"a/b"}` references the previous
step's structured result; empty path selects the whole result. `{$asset:"path"}`
references a resource in this verified bundle. Do not pre-execute a returned plan
through MCP. The terminal owns order, cancellation, callbacks and resource release.
Large sequences use a staged JSONL file and
`sequence:{path:"actions.jsonl",format:"jsonl"}` instead of inline actions.
Discover action/control byte budgets first; do not assume a fixed maximum count.

If loading a second VM is refused for memory, preserve the current one. Decide
whether the user's task warrants a declared notification → stop → load sequence,
using the discovered resource methods. Do not reduce OS admission protections.

Direct mutations through `invoke_resource` need a unique `request_id` and current
`expected_boot_id`. Retain identity through a lost response and read the receipt
with `read_operation`. Never silently repeat an uncertain effect, or call native
panel commands while BUSY. Acceptance, native completion and physical validation
are different. A device reboot invalidates old physical-state assumptions.

Model account workflows and private task data stay with the selected runtime.
Do not put prompts, audio, secrets or arbitrary user/log text into telemetry.
Recordings use short compressed RAM buffering without an explicit removable-media
retention policy; do not invent an internal-Flash recording fallback.
