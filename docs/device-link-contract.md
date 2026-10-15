# Hub / terminal contract

Pinned integration revision: 2026-10-15. Terminal-owned references are
`WishOS/docs/device-link.md` and `WishOS/docs/agent-actions.md` in the companion
repository. Hub owns transport/session adapters, not the terminal execution API.

## Link

`/services/link configure` accepts `{settings:{enabled:true,endpoints:[...]},persist:true}`.
Each ordered endpoint has unique `id`, `host`, `port`, `path`, `tls`,
`verify_peer`, optional `ca_pem`, `headers`, `reconnect_ms`, and heartbeat settings.
`attempt_timeout_ms:20000`, `retry_ms:5000`, `probe_interval_ms:60000`, `idle_ms:250`
are generated profile defaults. Legacy firmware receives `legacy_link` instead.

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
