---
name: wishos-packages
description: Prepare and validate complete WishOS runtime package revisions and whole-file updates before device delivery. Use when creating, installing or changing application code and resources.
---

A runtime revision uses the discovered `wishos-package/1` contract, not a firmware
image. package.json names the application entry descriptor, files.jsonl inventory
and its SHA-256. The sorted UTF-8 inventory contains canonical relative payload
paths, decimal-string byte sizes, SHA-256 values and optional kind (json/lua/asset); it excludes itself and the
package header. App source is text Lua. Do not include native drivers in a runtime
package or infer bytecode/firmware upload support.

Stage complete replacement files on the Hub. Use prepare_package for a new
revision, preflight_bundle to inspect one, deploy_package for admission/optional
activation and update_package for whole-file revisions; poll read_resource_job.
The selected application descriptor and declared JSON/UI controls are parsed.
Use kind:asset for large data JSON that the device only stores/streams. Lua sources
and the program entry remain code; an asset label cannot bypass Lua validation.
Keep books and recording histories outside application revision directories. Check the entire resulting revision: header, inventory,
content hashes, manifests, references, actual Lua syntax using the selected native parser profile, selected capabilities
and known budgets. Follow structured error diagnostics to fix the whole offending
file. Validation does not prove arbitrary application semantics, reserve runtime heap
or guarantee activation. A declared memory budget is the target's configured limit,
with its advertised accounting semantics, rather than a claim that so much free
heap exists or must be reserved before starting. Actual native allocation and
activation remain authoritative.

A file-level update identifies its installed base/catalog revision and carries
whole replacement files plus explicit deletions. Reconstruct and validate the
complete result upstream. Transfer changed files, and use a discovered bounded
local-copy operation for unchanged files. A changed base, device boot or capability
snapshot invalidates earlier assumptions. Never silently merge into a newer base.

Use native package validation after delivery. Install only with its successful,
matching validation identity and expected catalog revision. Preserve the validation
lease through catalog commit. A successful install consumes it; release it on failure or when no longer installing. Launch/foreground navigation
is a separate explicit action. Keep previous/running revisions and release resources
through normal lifecycle rules; deletion/retention remains explicit.

Ordinary media/file writes are not application admission. Do not bypass package
validation with raw filesystem writes, runtime load calls or a managed-result action
sequence. Use the schemas and tool instructions actually advertised by the device
and Hub; do not invent a method based on this guide's description.

UI preflight checks the selected renderer format, external screen/image references,
nodes/styles/layout and declared budgets. Symbolic/custom font aliases may be
registered during on_start; schema validation is separate from current native
render readiness. No preview/preflight establishes optical output or arbitrary
runtime semantics. Read get_device_components for actual device composition and
get_guidance for the pinned authoritative OS references, including packages.

Typed deployment releases only its own committed transfer receipt after native
validation admission acquires the package lease. Generic resource delivery keeps
that receipt for explicit consumer adoption; a managed OS result adopts it itself.
Do not add or reorder managed actions to compensate for transport bookkeeping.

When activate is false, successful deployment means installed, not running.
When requested activation fails, a failed job may still contain a successful
install receipt with the new revision/paths and a failed activation receipt.
Keep those outcomes distinct, preserve the old foreground if the native service
does so, and never invent an automatic rollback or repeat on_start.

For an explicitly chosen deployment interruption, deploy_package and update_package
accept `stop_current_before_transfer:true` together with `activate:true` (the stop
option defaults false). Hub first checks the entire resulting package, boot,
catalog revision and required methods; only then does it call the advertised
/sys/runtime stop, recording runtime_stop before transfer/preparation starts.
This may release memory for native workers without changing device budgets. A
later failure may leave the runtime stopped or the new catalog already installed;
read all receipts. Hub never silently enables this option, retries with it, rolls
back the catalog, or restarts old/new on_start. Without it the old VM is retained
through normal native admission. The option does not rewrite returned managed
application/system action sequences or their $previous references.

Transport loss during a declared read-only precheck may be reread within a bounded
same-boot recovery window. A mutation is only eligible to wait/retry while the
transport proves it was not dispatched. A sent mutation with a missing reply
stays uncertain and is not replayed. A response with result.not_dispatched:true
is a known failure of that requested call, even if an earlier precheck read lost
its reply; it does not undo earlier stop/transfer/validation steps. Inspect saved
receipts and current boot/catalog before a new explicit request. Failed package
staging is retained for explicit cleanup; never delete an old running revision.
