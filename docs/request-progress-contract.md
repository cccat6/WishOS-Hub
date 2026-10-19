# Request-bound public progress

The existing result protocol remains `wishos-result/2`, with ordered application
and system actions. Advisory progress neither executes an action nor acknowledges
completion. It does not extend deadlines. Device task retirement/boot identity
remain authoritative.

Discover `/sys/capabilities describe {path:"/services/remote"}`. Opt in only when
`methods` contains `progress` and `progress.format` is `wishos-progress/1`:

```json
{"format":"wishos-progress/1","method":"progress","text_limit_bytes":512,"min_interval_ms":1000,"serialized_limit_bytes":1024}
```

Send `/services/remote progress` through the existing boot-bound RPC:

```json
{"id":3,"request_id":"exact-peek-key","sequence":1,"progress":{"format":"wishos-progress/1","stage":"executing","source":"harness","text":"正在整理界面"}}
```

The outer envelope has `expected_boot_id`. Stages are `received`, `receiving`,
`transcribing`, `executing`, `preparing`, `transferring`; source is `hub` or `harness`.
Text is optional UTF-8, bounded both by text bytes and escaped serialized length.
Hub emits `transcribing` when its ASR executor actually starts, `executing` on
native Harness admission, `preparing` at result preflight and `transferring` before
bundle delivery. These are observations, not estimates of percent/time remaining.

The terminal requires numeric remote ID + exact request key, positive uint32
sequence and an unfinished request. Equal sequence/content is idempotent; old or
conflicting sequences are rejected. `read {id,include_payload:false}` exposes
`progress`, `progress_sequence`, `progress_at_ms` without loading the request body.
The `progress` event is only an identity notification, not the full text. Agent
service maps that remote ID to its own task ID; its read and small notification
retain task identity. Application packages decide visual wording/update frequency
and recover missed notifications by reading latest state. Native driver rendering
and display completion remain separate from this path.

Hub coalesces latest per request, uses background RPC at most once per advertised
interval (default one second), shares bounded sequence state across link rebuilds,
and re-sends the same snapshot idempotently after reconnect. Cancellation, device
replacement, close and terminal task retirement suppress stale delivery. Before
final delivery it settles the pending progress send; progress errors never change
the meaningful result or cause Harness replay. Progress failure does not authorize
another mutation. Old adapters with no positive declaration get no progress RPC.
Hub restart does not reconstruct a running conversation or restart a model turn.

Codex declares `publicProgress`: explicit same-thread/same-turn agent messages
with `phase=commentary` are the only text source. A classified commentary item may
stream bounded text, or its completed public message supplies a snapshot. Reasoning,
reasoning summaries, tool arguments/output, approval bodies and final result JSON
are never mapped to progress. Other adapters must opt in with a similarly verified
public event; arbitrary assistant deltas are not automatically public commentary.
No private reasoning is summarized by Hub. Sessions and provider credentials remain
owned by the chosen Harness. These snapshots are transient user-host state, not
telemetry or authoritative conversation storage.

Validation is separate: Host fixture semantics, real Harness commentary extraction,
real device progress reception, and each LCD's actual UI presentation. A successful
Host test does not establish the last two.
