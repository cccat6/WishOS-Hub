# Runtime package preflight and file revisions

Use the MCP package preflight/deployment tools when advertised. Discover the target
boot, `/sys/runtime`, `/sys/apps`, `/sys/ui` (when present), `/sys/resources` and
storage before generating code. Read the hardware package's ordinary startup
suite as a reference. The system, compiled drivers and runtime app are separate
components; changing an app does not rebuild firmware.

A package revision contains `package.json` (`wishos-package/1`) and a sorted,
streaming `files.jsonl` inventory. The header identifies the `wishos-app/1`
descriptor and inventory SHA-256. Each payload row identifies path, byte count and
SHA-256. Optional `kind` distinguishes lua/json controls from ordinary assets; large
JSON data can be explicit assets rather than control documents. Do not hand-invent hashes. Publishers produce these from exact file bytes.
The application descriptor's entry and all relative package paths stay inside
this revision; parent-relative paths are valid when they do not escape it.
Device-provided `/system/` libraries are shared references, not replacement GPIO
or native driver code.

Before delivery, the host compiles Lua text using the pinned 5.4.8 parser without
executing it, checks manifests/known references, and compares requirements with
live target capabilities and parser/resource limits. A JSON file is not proof of
a valid UI or app. UI documents use the renderer's advertised subset. Dynamic Lua
behavior cannot be proven statically; normal runtime budgets and failure handling
still apply. No guide can guarantee arbitrary generated code is correct.

After delivery, call `/sys/apps validate {manifest,package}` through the discovered
async completion interface. Its `validated` completion includes `operation_id` and
catalog `revision`; query `validation {operation_id}` for full diagnostics. The
native validator incrementally verifies hashes and compiles Lua without on_start.
UI/rule descriptions use the renderer's schema validation without presentation or
binding changes. Application-created fonts or resources are checked in their
actual execution context; package preflight does not run the app to create them.
Validation holds a read lease through the later install and has an advertised
bounded lifetime. Release abandoned checks with `release_validation`.

A managed sequence can use:

```json
{"type":"system","path":"/sys/apps","method":"validate","args":{"manifest":{"$asset":"app.json"},"package":{"$asset":"package.json"}}}
{"type":"system","path":"/sys/apps","method":"install","args":{"manifest":{"$asset":"app.json"},"package":{"$asset":"package.json"},"validation_id":{"$previous":"operation_id"},"expected_revision":{"$previous":"revision"}}}
{"type":"system","path":"/sys/apps","method":"launch","args":{"id":{"$previous":"application_id"}}}
```

These are consecutive ordered actions, not line patches or extra target types.
Insert application notifications where the workflow needs them, retaining the
meaning of `$previous`. Installation and activation are separate. Installing does
not select the launcher. Application/system actions remain freely composable.

For an update, inspect the installed manifest, package inventory digest and current
catalog revision. Supply whole replacement files and optional explicit file
removals. Preflight the complete resulting package, not only the changed file.
Publish to a fresh revision. Unchanged files can use the transfer adapter's
`copy_file` with source path, size and SHA-256; it copies bounded chunks locally.
Only changed files need network delivery. The new full copy still uses storage
space and writes on the selected volume; respect its quota and retention policy.

A running managed package has a read lease; raw filesystem/NFS writes cannot edit
it in place. A stale catalog revision, source mismatch, lost media, low memory or
failed persistence leaves the prior catalog and running application in place.
A later launch rechecks the package before activation. Keep old revisions until
explicitly unused and removed; do not delete an active revision. On reboot discard
old volatile handles and reconcile durable catalog state. A lost ACK is not a
reason to repeat installation/activation blindly.

Independent entry points are `/sys/runtime validate` (compile-only file/source)
and, when advertised, `/sys/ui validate` / `validate_app` (real UI/rules validation
without navigation or drawing). These support direct tooling; they are not a new
application workflow in the kernel.
