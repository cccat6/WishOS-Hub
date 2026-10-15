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

## Confirmed implementation follow-up

The terminal owner has supplied `WishOS/docs/package-contract.md`; that document
now owns the header/inventory, native validation and copy/install contract. Hub
uses it rather than inventing an independent format. Managed action sequences
explicitly request validate → install with validation/revision references → launch;
Hub never inserts steps into a user's ordered sequence or redirects $previous.

Lua parser: built stock **Lua 5.4.8**, source archive SHA-256
`4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae`, with
Emscripten 3.1.74 in build `38784325111`. The resulting portable compile-only WASM
has SHA-256 `5cd5812dd8ffa0ef03a93e5d6f97b5af4648272790ab2cd6b36240533154439b`.
Node and Workers use the same module; no user chunk is called and no libraries,
filesystem, process or network interfaces are opened for it. Wasmoon was used
only to investigate the ABI; its older Lua binary is not the shipped parser.

Stable reuse CLI after `npm run build`, requiring Node but no model/credentials:

```sh
printf '%s' '{"files":[{"path":"app.lua","source":"local x <const> = 1; return x"}]}' | node hub/scripts/check-lua.mjs
```

The script path above is relative to the parent workspace; from Hub use
`scripts/check-lua.mjs`. It reads one stdin JSON document and writes one stdout
`wishos-lua-check/1` document. `files:[{path,source}]` is the batch form;
`{source,name?}` is accepted for one file. Valid protocol with syntax rejection
returns exit 0 and `ok:false`; malformed/envelope-too-large input returns exit 2.
Diagnostics include actual parser version, filename and Lua-reported line/error.
The input envelope is bounded to 1 MiB as a host-tool policy, not a device limit.
The importable API is `dist/node-lua-compiler.js: nodeLuaCompiler()`, returning
`check(source,name)`. The core constructor is `compilerFromModule` for Workers.

Authoritative OS references are vendored from git objects at an explicit commit,
not copied from another agent's uncommitted files. Initial snapshot is
`d26ce10518b8fbede720dcf4a5fd59a9a9a415f4`; each file has its source path and
SHA-256 in `vendor/os-reference/snapshot.json`. The sync command is
`node scripts/sync-os-reference.mjs .. <full OS commit>`. The final snapshot will
be updated to the terminal owner's committed package/component contract before
integration completion. MCP serves these references alongside layer skills.

## Integration status — 2026-10-16

Terminal owner reported real C3 validation of component discovery, package
validation/install/launch, active-revision protection and invalid-Lua rejection
without replacing the old catalog/VM. Native copy_file on actual Flash caused a
restart and is under investigation by the terminal owner. Hub copy/update tests
remain host/transport validation only; no release or physical-pass claim for this
path until the terminal owner reports the repaired real-device result.

For updates, unchanged Lua/JSON control sources are read upstream for complete
preflight. Unchanged large binary assets are not downloaded to hash on the host;
the native local-copy operation must verify their expected digest. Preflight
reports this pending native check. User books and recording history stay outside
immutable app revisions. Changed download bytes, control-source upload/read bytes
and native copy bytes are distinct measurements.

Metadata follow-up for the terminal: Applications::document still enforces a
4096-byte manifest ceiling, but describe currently exposes only the package JSON
ceiling. Please advertise manifest_limit_bytes from the owning implementation so
Hub can check the exact target limit without hardcoding a C3/board constant.

Terminal follow-up: native copy_file cause was identified as recursive transfer
invoke stack use; the terminal owner refactored the shared file/status functions
and reports seven real C3 native scenarios passing after the fix, including
114KB local copying and restart/catalog recovery. Hub-to-device integration has
not yet been rerun by this task; these remain terminal-side native results.

UI preflight checks declared vocabulary and structure. It deliberately does not
require a font alias to be registered by an application that has not run yet.
Native schema_only validation and actual render readiness are separate stages.

Inventory control/data classification: Hub now carries optional per-file kind
`json`, `lua` or `asset` through MCP staging references and sorted inventories.
Known application descriptor is explicitly json. `.lua` remains compilable text
even if mislabeled asset. Explicit asset JSON is streamed/hashed without whole
JSON parsing; untyped non-package data is not rejected merely for its extension
or size. Package control JSON follows target bounds; managed action JSONL is
line-streamed separately from package payloads. This awaits the corresponding
committed native optional-kind contract before final integration.

Native Lua profile is now built in CI 38789794519 from Hub commit
90facc2c089fad3a90d42b6e2ec7d6c52d47bc1b with LUAI_MAXCCALLS=32. WASM
SHA-256 `4ef17b40be73c13897ec698ca15fca9656d1aa1042d877ba855054eb9b0d05dc` supersedes the initial stock-profile module above. The
compiler exports this profile and host/Workers compare a declared target profile;
a mismatch rejects before executable delivery rather than claiming compatibility.
This is the current supported native parser profile, not a universal RAM limit.

Hub behavior checks now cover real MCP tools on both local HTTP and local Workers
with paired WebSocket devices: preparation before writes, native package tickets,
install/activation, whole-file update/local copy and live device component index.
Install-success/activation-refusal retains the committed catalog revision and
installation/activation receipts while the old VM remains; it is not reported as
an all-or-nothing rollback and launch is never silently retried.

The current preflight honors manifest_limit_bytes when advertised and separately
checks the compiler's native_call_depth_limit profile. Inventory kinds require
target-advertised file_kinds before package writes. Final pinned OS reference
refresh awaits the committed schema_only/kind/profile/transfer fixes.
