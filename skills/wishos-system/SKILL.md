---
name: wishos-system
description: Use WishOS portable system services for runtime execution, files, events, resource calls, rendering and managed AI. Read when composing applications or coordinating capabilities through the public system API.
---

Discover the selected device's resource schemas and current boot before making
calls. Configuration scope, desired/applied state, read methods, async completion
and resource limits come from its metadata. These are different from a driver's
hardware facts and an application's chosen policy.

The system owns execution/loading, scheduling/admission, configuration, events,
conditions, callbacks, files, UI parsing/layout/rendering, presentation and service
coordination. Applications provide pages, styles, navigation and sequences of
capability calls. A factory suite is an ordinary replaceable application reference.

Use declared async operations and completion callbacks. A transport ACK, accepted
operation, application ACK and physical display completion are distinct receipts.
Respect display readiness; do not interrupt an active panel refresh. Handle inputs
and concurrent audio according to runtime-configurable application behavior.

Keep handles and resource ownership until their declared completion, then release
streams/files/operations/validation leases. Application replacement cannot redirect
a result to another VM instance. The independent home/voice route remains reachable.

Read actual region/provider capacity and configured quotas; do not assume a fixed
application memory limit, SD card, Flash fallback, display geometry or MCU family.
Known budget compliance is not a guarantee of future free heap or successful native
admission. Runtime memory/instruction limits still apply after validation.

Applications call the system AI API. The Hub adapts the selected user Harness;
model/session/provider logic does not belong in hardware drivers. System-targeted
and application-targeted results form an ordered action sequence. Keep deterministic
local tasks local. Large source retrieval, indexing and heavy parsing/rendering
happen upstream when the device's discovered budgets require it.

Network, time/timezone, proxies, logs and telemetry are system services with
configurable policies. Never place prompts, credentials, audio or arbitrary user
file/log text into diagnostic telemetry. Recordings use independently decodable
compressed blocks; storage/retention is explicit policy, not an implicit Flash spool.
