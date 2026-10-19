# WishOS Hub ownership and integration rules

This independent MIT repository owns MCP, host connectors, cloud relay, Harness
adapters, resource processing and deployment. The parent WishOS repository owns
terminal firmware and portable OS services. Do not edit parent firmware, hardware
packages or another live device experiment from the Hub task. Agree interface
changes through versioned contracts and tests.

## Human-controlled GitHub publication

- Keep ordinary development, testing, device integration and completion work local.
  Push only when the human user explicitly asks for a push; completion, continuation
  and agent coordination are not publication authorization.
- Do not automatically create/update GitHub releases or pull requests, or dispatch
  GitHub Actions. These remote actions also require an explicit human request.
- Preserve existing remote state. Local edits, checks and commits remain allowed;
  do not publish this rule change or subsequent work merely as part of wrapping up.

- Read docs/integration-architecture.md before changing the integration surface.
- MCP tool access, session-trigger ingress, transport connectivity, ASR, Harness
  admission and physical completion are distinct capabilities and receipts.
- Standard MCP is not a universal way to wake or steer a host conversation.
  Use documented Channels, ACP, SDK or session APIs, with capability negotiation.
  Do not impersonate a supported adapter with an arbitrary shell command or claim
  a test fixture is live vendor validation.
- Public WishOS infrastructure must not collect model API keys, provider account
  refresh tokens or authoritative conversation transcripts. User-owned connectors
  may use credentials from the user's chosen runtime. Cloud pairing credentials
  are WishOS-scoped, not model credentials. Never migrate sessions by reading and
  rewriting another Harness's database while it owns the conversation.
- Direct API users select a user-owned agent runner (for example OpenClaw or
  Hermes). Do not build another hosted model/session service for WishOS.
- MCP transport sessions are not Agent conversations. Pin dependencies; support
  negotiated protocol versions explicitly, including the 2026-07-28 changes.
- LAN preference is based on verified paired identity and reachability from the
  executing connector, not the user's browser location. Preserve operation IDs
  and reconcile uncertain mutations before failover. A cloud relay does not make
  an offline local Harness available.
- Device and connector outbound connections provide NAT traversal by relay;
  do not require fixed DHCP leases, inbound router ports or UPnP. Cloud sessions
  cannot directly reach a private LAN just because the user's phone is there.
- Cloud relay retention is bounded delivery state. Do not persist prompt/audio
  bodies or include them in access logs. Do not claim end-to-end encryption merely
  because both connections use TLS. Host-side artifact/session retention belongs
  to the user, separately from relay transport buffers.
- Deliver a deployable release with a browser-based setup UI and simple launchers.
  Docker Compose is not a prerequisite. Keep model credentials out of release
  assets and client configuration exports. Publish only after the owner approves the exact source and artifact set.
- Keep native tests, SDK protocol fixtures, package installation smoke checks and
  live-provider validation distinct. Implement available documented interfaces;
  mark external developer-app approval/account prerequisites accurately.

- After context recovery, reread this file and the public integration/device/result
  contracts before continuing. Keep any local engineering evidence private and
  separate from distributable source and package contents.
- Read the companion WishOS input/layout contract when changing upstream UI
  validation. Keep capability values machine-readable and native validation authoritative.
- Record filesystem paths from local file URLs with fileURLToPath, never
  URL.pathname; verify handoff paths can be reopened before reporting them.
