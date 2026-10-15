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
file. Validation does not prove arbitrary application semantics or future heap.

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
