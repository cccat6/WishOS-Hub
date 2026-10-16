# Runtime package admission and whole-file revisions

Version 1, implemented with the 2026-10-16 native and Hub bridge. The portable OS owns
native admission and catalog commit; Hub owns preflight before device writes.
Native drivers remain compile-selected components. This format describes runtime
application files, not firmware updates or native driver installation.

A revision is an immutable directory with:

- `package.json`: `{format:"wishos-package/1",entry:"app.json",inventory:"files.jsonl",inventory_sha256:"<sha256>"}`.
- `files.jsonl`: one `{path,bytes,sha256,kind?}` per nonempty line, sorted by the UTF-8
  bytes of the canonical relative path; `bytes` is a decimal string. The inventory
  lists every package payload including the application descriptor, excluding
  package.json and the inventory itself. Kinds are `lua`, `json` or `asset`; the program entry and `.lua` files are always compiled.
  An explicit asset is hashed as data, so large JSON data need not be parsed as UI/control metadata.
- The `wishos-app/1` descriptor and its runtime resources. Relative references may
  contain `..` provided they stay within the revision; `/system/` shared libraries
  are device-provided dependencies, not duplicated native code.

The manifest and inventory are streamed/hashed with bounded buffers. A native
validator checks canonical paths, byte counts/digests, Lua 5.4.8 syntax, declared
JSON/UI formats and the application's capability/budget requirements. UI schema validation
uses the renderer's shared vocabulary without requiring application-created font
or image bindings. Default `/sys/ui validate` additionally checks current render
preparation without presentation. Preflight does not execute
on_start or prove arbitrary dynamic program semantics. Native runtime preparation,
instruction/memory limits and completion/lifecycle rules remain authoritative.
A VM memory budget is an elastic ceiling, checked on actual allocation growth;
it is not a reservation or a promise that the whole ceiling is currently free.
Native services retain their own required headroom. Preflight, installation and
activation receipts are distinct, including when a valid installed revision
cannot activate while another runtime or TLS connection consumes memory.
Validation scratch is released at completion; the revision lease remains held
until explicit release or catalog commit.

## Device ABI

- `/sys/runtime validate {file|source,memory_bytes?}` compiles text only using the
  native parser, preserves the current VM and has no application side effects.
- `/sys/ui validate {path,schema_only?,...view settings}` validates the real document/resources
  without navigation, bindings or display submission. `schema_only:true` checks
  structure and reports render_ready:false; runtime resource bindings may be
  created later by the app. Exposed only by a UI adapter.
- `/sys/apps validate {manifest,package}` starts a native incremental package check.
  Returns `operation_id`; async success is `validated`, failure is `failed`.
- `/sys/apps validation {operation_id}` reads the retained validation outcome.
- `/sys/apps release_validation {operation_id}` releases its package read lease.
- `/sys/apps install {manifest,package,validation_id,persist?,expected_revision?}`
  commits only the matching successful check. Validation holds the revision read
  lease/provider pin through catalog persistence. Failed admission leaves prior
  catalog/foreground intact. A package install records the package path and
  inventory digest. A later launch rechecks the native package and then follows
  normal application preparation and activation; old foreground runs until then.
- `/sys/transfers copy_file {id,path,source,bytes,sha256}` copies an unchanged
  file locally into the fresh receiving revision. It returns while copying;
  `/sys/transfers read` exposes state `copying`, file offset and errors. Each poll
  performs at most one bounded chunk. Final digest/flush/rename match uploaded
  files; no next file is admitted before copying settles. Abort/cancellation
  releases source/destination leases; partial data is retained for explicit cleanup.

Methods, formats, parser versions and byte bounds are discovered; callers must not
infer their presence from an MCU name. Package validation is explicit and is not a
side effect of discovery/status/path resolution. Metadata limits belong to this
implementation, not a statement about every future device's RAM or Flash.

## File-level update

Hub snapshots the installed manifest/package and catalog revision. The update
request carries whole replacement files plus optional whole-file deletions. Hub
constructs and preflights the entire resulting inventory before device writes.
Only changed files cross the network. Unchanged files use copy_file from the old
revision and must match its expected digest. This may write a second copy on the
configured target volume; it is not an in-place edit or a line patch.

After delivery, native validation runs; install uses expected_revision and the
validation identity to prevent a stale patch overwriting a newer catalog update.
Activation is a separate explicit operation. Running revisions retain read leases;
old revisions are not automatically deleted. Removal/retention stays explicit.
Lost replies are reconciled by boot, request and operation identities, never by
blindly repeating catalog or activation effects.

Ordinary filesystem writes still store documents/resources. They do not authorize
application installation. A running managed revision cannot be overwritten through
filesystem/NFS writes; leases and normal provider interfaces enforce the same rule.
