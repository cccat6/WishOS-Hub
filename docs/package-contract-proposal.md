# Runtime package integration contract

The former proposal is implemented. The companion OS owns the native ABI;
`vendor/os-reference/snapshot.json` identifies the exact committed reference and
digests, exposed through MCP `get_guidance` and resource references. This document
summarizes Hub behavior; it does not define an alternative device ABI.

Hub and Workers share compile-only Lua 5.4.8 WASM and the same complete-file
preflight. The module profile/hash is pinned in vendor/lua-parser/provenance.json;
both environments compare an advertised target profile. No application executes
during validation. Checks cover source identity, recognized controls, inventory,
static references, capabilities and declared budgets. Dynamic behavior and future
native resource availability remain native runtime responsibilities.

New packages use wishos-package/1 header and sorted files.jsonl. Every deployment
path performs preflight before storage preparation or device writes. Ordinary
staging/data delivery remains available without claiming an application is valid.
Updates create fresh immutable revisions with whole-file replacements/deletions;
unchanged control files are read for preflight, large unchanged assets are copied
and hashed by the native transfer service. Active/previous revisions are protected
by their leases and catalog revision guards.

Typed deployment runs transfer → native validation → catalog installation →
optional activation, retaining each receipt. A failed activation may leave a
successfully installed package. Default deployment retains the current VM;
explicit stop_current_before_transfer requires activate:true and complete checks
before the stop. No implicit stop/retry/rollback occurs. Managed result sequences
remain the caller's ordered application/system actions, not a rewritten Hub plan.

Application placement follows `/sys/apps describe.install_providers`; factory
initial reference follows `factory_launcher`. Preflight is read-only; delivery rechecks the
actual target after explicit preparation. Ordinary media uses `/sys/transfers`
policy independently. Device packages choose SD or explicitly quota-limited Flash;
Hub does not infer policy from MCU/Flash capacity or presume `/system` is writable.
The initial Launcher is a normal package selected by device configuration.

The host bridge preserves request/boot identity and treats lost responses as
uncertain unless transport proves the request was not dispatched. Native accepted,
validated, installed, activated and physically completed are distinct states.
Read-only recovery does not authorize replaying an uncertain mutation.

Validation scopes and contributor checks are described in validation.md.
