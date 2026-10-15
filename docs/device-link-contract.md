# Hub / terminal contract

Pinned integration revision: 2026-10-15. Terminal-owned references are
`WishOS/docs/device-link.md` and `WishOS/docs/agent-actions.md` in the companion
repository. Hub owns transport/session adapters, not the terminal execution API.

## Link

`/services/link configure` accepts `{settings:{enabled:true,endpoints:[...]},persist:true}`.
Each ordered endpoint has unique `id`, `host`, `port`, `path`, `tls`,
`verify_peer`, optional `ca_pem`, `headers`, `reconnect_ms`, and heartbeat settings.
`attempt_timeout_ms:20000`, `retry_ms:5000`, `probe_interval_ms:60000`, `idle_ms:250`
are generated profile defaults. The public connector emits the endpoint form.

`_wishos._tcp` advertises the connector's stable `.local` host and port. Each paired
device uses the same scoped grant for LAN and relay; identity is never its DHCP IP.
Existing explicit proxy bypass rules are preserved. A positive preferred-endpoint
TCP probe proves reachability only; the actual WS/TLS/auth exchange still runs.
Switchback waits for RPC idle. Heartbeat liveness is separate from task deadlines.

Frames remain `wishos-rpc/1`, with boot IDs and bounded control/stream chunks.
A connection or generation change never authorizes replay of an uncertain mutation.
The Hub guard preserves request identity and receipts, not whole-panel state.

## Managed AI

Request payload: `{format:"wishos-ai/2",input:{...}}`; no target field.
Result: `{format:"wishos-result/2",operation_id,actions:[...]}` or a staged JSONL
`sequence:{path,format:"jsonl"}`. Hub includes `transfer_id` after bundle delivery.
Only application/system categories exist; they may alternate freely. There is no
single-effect or fixed-action-count restriction. Discover `/services/ai` metadata
for request/result format and action/inline byte budgets.

Application actions default to the original VM and `wait:"processed"`; processed
is the exact VM's `read_action` plus `acknowledge` barrier. `wait:"queued"` only
queues a notification. Explicit `recipient:"foreground"` resolves at its step.
System steps call advertised resources and wait for declared native completions.
`$asset` and `$previous` are structured references, not substituted strings.

Only the terminal executes the ordered result. It owns bundle leases, origin
identity, foreground transitions, callbacks, BUSY serialization and safe cleanup.
A service error may preserve diagnostic result data readable in chunks. The Hub
must not turn it into an invented success or discard it because transport ACKed.

Physical C3 validation in the terminal chat confirms a second concurrent VM may
be refused under memory admission. Agent plans can explicitly notify → stop → load
when appropriate; Hub does not silently weaken admission or replace the old VM.

## Fault boundary

A request disappearing from a successfully read outbox is explicit retirement;
managed native work may be interrupted through its adapter. A carrier disconnect
is not cancellation: retain run/receipt identity and reconcile it on reconnect.
Device reboot, request retirement, Hub shutdown and server crash are distinct.
Hub unknown outcomes block a new device-bound Harness turn until the local owner
inspects the native session and acknowledges the outcome. Cancellation does not
promise rollback or immediate native completion.

## Application placement

`/sys/apps describe.install_providers` positively declares allowed provider IDs
(CSV), and `factory_launcher` identifies the configured initial reference. Hub
preflight checks a package against the current ordered transfer target without
mounting or writing storage. Explicit delivery may prepare storage, then rechecks
the actual target before beginning package transfer. Native validation/install
remains authoritative. This restriction does not apply to ordinary data delivery.
No MCU family or Flash-size heuristic is used. Initial and user launchers have
normal application lifecycles. The current terminal design provisions ordinary
Launcher/page files into LittleFS at `/storage/flash/factory` using the factory
`runtime.littlefs.bin` image. This is the device package's initial reference, not a
grant to install user applications on Flash. C6 may still advertise only `user`
(SD) in install_providers; another package can explicitly permit Flash.

`/system` remains read-only for system metadata, standard Lua helpers and the
ordinary recovery application. Helpers retain `/system/lib/input.lua` and
`/system/lib/ai.lua` runtime URIs; their source is now `firmware/WishOS/lib/` in
the OS repository. Hub guidance ships references, not another copy of the runtime
libraries. The new native source pin and joint acceptance are pending the terminal
owner's final commit; published old-release evidence remains unchanged.


## Storage catalog pagination

Hub internal placement/preparation starts `/fs mounts` without page arguments
(new devices default to four rows), then follows `next_cursor` using
`{cursor,limit:4}` until `more` is false. The first call also works on older
devices that reject page arguments. A missing
`more` ends enumeration for older devices. A failed page or boot change rejects
the enumeration rather than presenting a partial/empty catalog as success.
The same reader is used before and after preparation and in package preflight.

`/sys/storage read` independently pages providers via cursor/limit and
flash_partitions via partition_cursor/partition_limit. Generic resource callers
follow the corresponding returned cursors and more flags; Hub's ordinary package
preflight does not need this combined resource. Reading these catalogs neither
mounts/probes media nor builds an index, and it does not change installation or
download permissions. Local and cloud MCP share this mechanism.
