# Session control and request context

Contract v1. This is a user-host Harness reference service,
not an authoritative conversation store. The Harness native runtime owns history and
credentials. Ordinary device apps keep only mode, selected references and pending
operation IDs in their preferences. No Harness-specific kernel service is added.

## Device request

Use `/services/ai submit`. The OS supplies `wishos-ai/2` and trusted snapshot
`payload.context = {current, launch_origin?}`; input is not rewritten by the OS.
Hub preserves current/launch-origin identity and view/revision/path as data in
both text and voice requests. It does not guess a target from today's foreground.
Native instance/revision checks remain authoritative before effects.

For ordinary text/voice input, optional session fields are:

```json
{"session_id":"native opaque ID","runtime_id":"configured runtime ID","session_scope":"server-issued opaque namespace"}
```

`session_id`: 1–256 characters, no CR/LF/NUL. `runtime_id`: configured identifier,
up to 64 ASCII characters. `session_scope`: opaque, at most 64 characters; preserve
it unchanged. References are scoped to the selected user-host runtime/profile.
Stale or foreign references reject before admission; never implicitly create a
replacement. Legacy session_id-only requests remain compatible.

The first implementation manages sessions in the device's configured runtime;
it does not silently reconfigure the connector or switch provider credentials.

## Control input

All inputs have `kind:"session_control"` and an operation. Optional runtime_id
selects/validates the configured runtime. Only advertised operations may be used.

| operation | Additional fields | Behavior |
| --- | --- | --- |
| status | optional session reference; optional operation_id | Read operations/default reference, selected metadata or a creation receipt; no creation. |
| list | cursor:null/string, limit:1–20 (default 5) | Page native session metadata. |
| create | operation_id:1–64 identifier | Explicitly create once; retain operation_id until outcome is known. No model turn. |
| select | session_id, optional runtime_id/session_scope | Resolve and validate a native reference; return it for this app, without changing the device-wide default. |
| messages | session reference, cursor:null/string, limit:1–20 (default 5), text_max_bytes:8–1024 (default256) | Page bounded public user/assistant excerpts. No reasoning, tool outputs or system/developer instructions. |

Cursor is an opaque server-issued reference, at most 128 UTF-8 bytes. The user-host
service retains the native cursor in a bounded expiring RAM table, scoped to
device/runtime/profile/operation/session. It does not truncate the native cursor.
Expired or evicted references return session_cursor_expired, never an empty final page.
Do not parse, trim or reuse it for a
different operation/session/profile. The factory UI requests limit 3, titles of at most 40 Unicode characters and bounded
message text; these are app/service defaults, not OS-wide limits. Actual returned
entries may be fewer than limit to fit the device's declared action/result envelope. Nonempty next_cursor
means continue even when a filtered history page contains no visible messages.
No large history hydration fallback is allowed.

## Reply

An ordered `wishos-result/2` application action, topic `session_control`, normally
origin/processed. Transport completion means delivered/processed, not that a
control operation with `ok:false` succeeded.

Common data:

```json
{"format":"wishos-session-control/1","operation":"list","request_id":"native request key","ok":true,"runtime_id":"codex-local"}
```

Reference: `{runtime_id, session_id, session_scope}`. Session entry:
`{reference, title, summary?, created_at?, updated_at?, state?}`. Timestamps are Unix
seconds when supplied by the Harness; title/summary are native metadata, not a new
AI-generated summary.

- status: `operations:string[]`, `default_session:reference|null`,
  `selected_session:reference|null`, optional `session:entry`, and `limits`.
  If operation_id was provided, `creation:{operation_id,state,selected_session?}`
  describes its receipt, not proof that the session is still reachable.
- list: `entries:entry[]`, `next_cursor:string|null`.
- create: `operation_id`, `selected_session:reference`, optional `session:entry`.
- select: `selected_session:reference`, `session:entry`.
- messages: `entries:[{message_id,role:"user"|"assistant",text,truncated,created_at?}]`,
  `next_cursor:string|null`. These are bounded previews, not a device chat archive.
- failure: `ok:false,error:{code}`, plus operation_id for uncertain creation.
  An uncertain create must be reconciled through status/native catalog, not retried
  with a fresh key. The same key with different parameters rejects.

Creation and first-message persistence follow the native Harness contract. A
created empty local thread must not be advertised as durable merely because Hub
saved its reference; failed resume never silently becomes a new conversation.

## Fixed/selectable mode

Modes belong to app preferences/UI, not native kernel branches. Fixed mode captures
one reference at startup (saved reference, or status.default_session once). An
empty default needs explicit create. Selectable mode lists/selects and retains the
returned reference. Both attach all three reference fields to later voice/text
requests. Changing an app's selection does not retarget an in-flight request or
mutate the connector's global default. Reopening a conversation uses the native
session and bounded messages; it does not reconstruct history on the device.

App modification and display-only requests carry system context plus an explicit
application intent/subject in input. Context is a submission snapshot, not a
permission to bypass native owner, view, inventory or catalog revision guards.
Package update/install/activation and transient view updates retain their distinct
existing contracts and receipts.

## Explicit editing/display intent

Applications may add input.intent, for example
`{effect:"application_update",target_context:"launch_origin"}` or
`{effect:"display_only",target_context:"current"}`. These are declared application
intent examples, not a closed kernel workflow enum or authorization grant. Hub
preserves them as data together with the immutable system context. Updating stored
app code still requires native catalog/package revision validation; changing a
view still requires its native identity/revision contract. Missing targets must
not be filled by guessing the current foreground, and old-version rejection must
not be weakened. Voice must retain this context through ASR before admission.

## Harness tools and capability coverage

`harness_sessions` exposes status/list/select/messages for the configured user-host
runtime. `create_harness_session` is a separate explicit mutation with a stable
operation_id. Select/create returns a `selection_action` template. To honor a
spoken request such as “switch back to my previous conversation”, resolve the
catalog reference, then include this template in the ordered managed result.
The tool itself does not switch the app, change global defaults or execute a model
turn. Only the app's processed acknowledgement confirms it accepted the selection.
Hub revalidates the complete reference against the current configured runtime and
native catalog before delivering a model-produced selection action.

The current catalog adapter is Codex app-server. Other adapters continue to expose
their existing execution/speech capabilities; session control advertises only the
operations they implement, rather than emulating a second conversation database.
Codex catalog calls are `thread/list`, `thread/read` with includeTurns:false, and
`thread/turns/list` with itemsView:summary. Message pages are newest first, with
native display excerpts marked preview:true. `truncated` describes additional Hub
byte limiting; preview:true means this is not an authoritative full transcript
even when truncated:false. Titles can be empty; apps supply a useful fallback.
Temporary Codex threads support metadata but reject history paging in the tested
native runtime. Such failures remain errors, not an empty history page. Starting
or reading a session does not establish safe concurrent writer ownership over an
unrelated active desktop conversation.

For pending creation, only state:completed together with a selected_session can
settle the app's pending operation. Executing, uncertain, not_found and
scope_changed do not select the default or justify an automatic new create.
An app may explicitly abandon its pending reference after informing the user;
this neither deletes the native session nor proves creation did not happen.

