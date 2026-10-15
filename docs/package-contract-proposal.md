# Package validation and guidance contract — proposal for terminal coordination

2026-10-16. Hub owns only this repository. No hardware operation is performed by
this task. Device API names and the final version/update envelope remain pending
terminal agreement; the names below describe required behavior, not a new ABI.

## Current audit

| Entry | Current validation | Gap to repair |
| --- | --- | --- |
| MCP `stage_resource`, binary HTTP upload | Source/size/host quota and SHA-256 | Staging is not deployment and must remain usable for arbitrary assets; no syntax claim |
| MCP `deliver_resources` → local Hub → ArtifactStore → deliverBundle | Relative names, duplicate list, source identity, chunk/resume/hash | No application manifest, Lua parse, reference or device-budget preflight before begin |
| Cloud MCP delivery → CloudArtifacts → same deliverBundle | Same transport checks, with separate cloud quota | Must run the same validator as local, including actual Lua syntax parsing |
| Managed `wishos-result/2` | Action envelope, structured references, JSONL action/control budgets | Can currently transfer an invalid application package; needs the same bundle and action preflight |
| Generic MCP/API `invoke_resource` | Live schema + boot identity + mutation receipt | Application install/runtime load and raw file writes can bypass a typed package workflow; distinguish ordinary filesystem data from deployment authority |
| MCP instructions / skill | Long instructions + static repository skill | No resources/prompts or component catalog; installing an MCP client does not automatically load a local skill file |

Current terminal sources use `wishos-app/1` (id/title/entry/requires and execution
budgets), `notes-app/1` for UI/rules, Lua **5.4.8**, and read-only capability
contracts. Factory launcher manifests legitimately use `../startup.lua` inside the
bundle tree; reference normalization must allow `..` within the bundle and reject
only actual escape. Do not reject all parent-relative references.

## Host mechanism to implement independently now

One validator runs against an immutable snapshot of the complete file list, file
bytes, digest/size and boot-scoped target metadata. Every shared bundle delivery
entry invokes it before storage preparation or `/sys/transfers begin`.

- Validate canonical destination names, collisions, missing files and source digest.
- Parse declared JSON manifests/documents and compile every declared Lua source
  with an actual pinned Lua 5.4 compiler in compile-only mode; never execute app
  code to validate it. Return parser version and file/line diagnostics.
- Validate manifest required fields, entry and statically knowable references.
  Dynamic references cannot be proved; report this boundary rather than using a
  regex as a program validator. Device authority repeats native validation.
- Check declared resource methods against discovery from the same boot. Check
  source/document/action and declared memory budgets against advertised limits.
  Never transplant one C3 value as an OS-wide limit. Insufficient/missing metadata
  must not become an invented success; expose which validation is still needed.
- A rejected package performs no device-side writes, mounts, transfer begin or
  application/catalog effects. Read-only discovery is allowed.
- The receipt identifies content hash, validator version and target boot/schema.
  It is advisory evidence, not a permission cache. Revalidate after source, target
  boot, capability/configuration or adapter changes; keep source leases through
  validation and delivery so the checked bytes cannot change mid-operation.
- `wishos-result/2` JSONL and inline paths use the same action validation. Known
  app/runtime/UI source references are validated before transferring their bundle.

Preflight does **not** prove arbitrary Lua semantics, safe real-time behavior,
actual peak allocations, image quality or future resource availability. The native
runtime's admission/scheduler/resource rules remain authoritative.

## Device-side authority / update proposal (await agreement)

The terminal should expose a discoverable package validation capability and its
schema/budgets. Hub must discover the supported operation rather than hardcode a
new `/sys/...` API. The native validator is used before activation/catalog mutation
and is shared with restore/boot selection.

Proposed update semantics: immutable revision directory; complete resulting file
inventory with hashes; optional source revision plus whole-file replacements and
explicit deletions. The device performs bounded copies of unchanged files into a
new revision, verifies the complete result, then atomically switches its catalog
reference. Running/old revisions are not overwritten; cleanup respects their
leases and explicit retention. No line-oriented patches.

Please confirm: manifest/version representation, inventory reference form, native
validation discovery metadata and request/receipt, copy/commit operation and
completion semantics, retention/rollback ownership, and how read-only target
limits are exposed. Hub will adapt after confirmation instead of independently
selecting these names or silently reusing unsafe direct install calls.

Ordinary filesystem writes remain useful for documents and media. They are not
package admission. To promise that all *package* deployments are validated, normal
MCP install/load/update actions need the package gate, and native immutable package
paths/catalog activation must reject raw-write bypass. A caller storing arbitrary
bytes as a document is not proof that they are an installable application.

## Discoverable guidance

Expose a versioned component index through MCP resources, a short authoring prompt
and tool-return links. Sections: portable system services, selected native drivers
and topology, runtime applications/factory reference suite. Static system/app
skills are bundled locally with Hub and cloud; device-specific component/schema
and skill references are read through the device's advertised discovery interface.
Do not invent capabilities for absent peripherals. Each guide links to schemas,
callbacks, completion/resource release, budgets and the file-level update workflow.

Tests use actual MCP clients (instructions, resources/list/read, prompts/list/get,
tools), actual Lua parser fixtures including Lua-5.4 syntax, all delivery routes,
malformed/oversize/missing reference packages, boot/config changes and no-write
assertions. Local and cloud checks use simulated sockets in Hub; the terminal
owner alone performs real C3 tests and leaves E6 untouched.
