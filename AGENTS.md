# WishOS Hub ownership and integration rules

This independent MIT repository owns MCP, host connectors, cloud relay, Harness
adapters, resource processing and deployment. The parent WishOS repository owns
terminal firmware and portable OS services. Do not edit parent firmware, hardware
packages or another live device experiment from the Hub task. Agree interface
changes through versioned contracts and tests.

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
  assets and client configuration exports. Publish internally/private until the
  user asks to make the project public.
- Keep native tests, SDK protocol fixtures, package installation smoke checks and
  live-provider validation distinct. Implement available documented interfaces;
  mark external developer-app approval/account prerequisites accurately.

- After context recovery, reread this file and docs/engineering-corrections.md in
  full, plus the companion ../AGENTS.md and ../docs/engineering-corrections.md
  read-only. Resume open acceptance against the current source/live identities.
  Record each confirmed deviation with evidence, owning layer, cause, corrective
  mechanism and separate Host/build/physical/online validation status.
