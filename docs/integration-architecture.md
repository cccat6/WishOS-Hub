# WishOS connectivity and Harness integration

Research date: 2026-10-15. This is the implementation contract for the split
WishOS Hub task. Documentation compatibility is not live account validation.
Terminal OS remains in `cccat6/WishOS`; host/MCP/relay code is `cccat6/WishOS-Hub`.

## Product decision

Keep one public tool surface: WishOS MCP. Preserve two independent directions:

1. A Harness calls WishOS tools to discover/control a device and deliver resources.
2. A device event asks the user's selected Harness session to execute work.

The second direction requires an explicitly supported session ingress. MCP
sampling, notifications and MCP transport sessions do not establish a universal
conversation-control API. The optional connector runs on the user's computer,
NAS or server; an stdio MCP installation may launch its lightweight process.
A local browser wizard replaces a heavyweight desktop GUI initially. Normal
users configure a pairing code and select a Harness/session, not DHCP or ports.

The hosted service supplies authenticated MCP access, pairing and a bounded
relay. It does not become an LLM provider or authoritative conversation store.
No hosted model API-key intake. A direct-API user runs an existing agent runner
such as OpenClaw or Hermes, or supplies another supported user-owned adapter.
The runner owns the model key, tool loop and history. A personal server is one
option, not an absolute requirement: a PC/NAS or a vendor-managed Harness can be
the execution host. Something authorized must be running when a device triggers it.

## Research matrix

| Client/runtime | MCP tool access | Device-triggered conversation | History and credentials | Implementation boundary |
| --- | --- | --- | --- | --- |
| ChatGPT web | Remote HTTPS MCP/plugin; plan/admin policies apply | No documented general API found for injecting into an arbitrary ordinary ChatGPT conversation; do not advertise it | ChatGPT owns its chats/account | Remote tools compatible; no fake reverse-trigger capability |
| Codex | stdio and Streamable HTTP | App-server thread/turn APIs; `turn/steer` requires the active expectedTurnId | User's Codex host/account | Attach through the supported host endpoint; separate controlled sessions from unrelated live desktop sessions |
| Claude Code | stdio/HTTP MCP | Channels pushes into an opted-in running session; SDK/headless supports controlled sessions | User's Claude host/account | Channels are an explicit Claude extension, currently stdio and research preview; notification write is not processing ACK |
| DeepSeek Harness | Official stdio/Streamable HTTP MCP client | Current API Gateway/session-controller has prompt/create/resume/queue controls; Python SDK is another profile-based surface | Chosen DSH home/session store | Pin a version; older sdk RPC adapter is not automatically compatible with today's gateway. Respect writer ownership and requestId receipts |
| WorkBuddy | MCP+Skill, HTTPS SSE/streamableHttp, stdio, OAuth or local token injection | Official Open API offers local-assistant messaging and cloud task ACP | WorkBuddy owns chats; user-owned connector holds required authorization | Developer application/client-secret approval is a prerequisite. MCP-only configuration does not grant Open API access |
| Cursor | stdio/SSE/Streamable HTTP MCP | CLI ACP/headless/resume or Cloud Agents API followups | Chosen Cursor runtime/cloud account | CLI session, editor chat and Cloud Agent are different surfaces; do not promise arbitrary editor-chat injection |
| OpenClaw | Its configured tool integration; WishOS MCP can be connected by the runtime | Gateway control/OpenResponses endpoint | User-owned Gateway state and provider credentials | Endpoint is opt-in; preserve session lineage and route identity |
| Hermes | Configured MCP tools | API server runs/session chat; gateway WS for an existing conversation owned by another surface | User's Hermes home/profile | API-session id cannot take over CLI/TUI/Desktop session (409); use advertised gateway prompt ingress |
| Bare model API | Not itself a complete device agent | Needs an agent loop, tool execution and history owner | User-owned runner or provider storage by explicit choice | Supported through runners, not a second WishOS cloud session engine |

Evidence for each row is listed below. Installed clients, available authorization,
protocol negotiation, adapter fixtures and real executions must have separate
status fields in UI/metadata. A ready MCP connection alone is not `canTrigger`.

## Protocol findings

- The public connector now pins official TypeScript MCP server/client 2.3.1
  and explicitly negotiates 2026-07-28 plus older revisions on the same endpoint.
  SDK 1.32.1 remains a development-only older-client fixture. Specification
  2026-07-28 includes: per-request metadata,
  `server/discover`, resultType, subscriptions and MRTR replace parts of the old
  initialize/session/GET-SSE model. Keep older clients working and test both
  generations; do not merely advertise the new date on old behavior.
- MCP transport state does not contain the user's conversational memory. Sampling
  is client-optional and is not a way to select an existing arbitrary conversation
  or reliably start a background turn. Claude Channels is a specific extension.
- Claude Channels uses `experimental.claude/channel` and
  `notifications/claude/channel` over stdio. Client policy/flags must opt in.
  Persist a delivery identity and expose an acknowledgement/result tool because
  `notification()` resolving does not mean the Agent processed the input.
- WorkBuddy Open API uses OAuth 2.1; cloud ACP is receive-SSE + send-POST with
  `Acp-Connection-Id`. `session/prompt` response, not an intermediate notification,
  is the turn's completion. Do not leak its client secret into a device/app.
- Model APIs are not just two schemas: OpenAI Responses differs from Chat
  Completions, Anthropic Messages is another contract, and Gemini has native
  generateContent. OpenAI Conversations can persist state at the provider; that
  is not an ordinary ChatGPT conversation. Anthropic Messages is stateless. The
  compatibility layer belongs in the selected runner, not WishOS firmware.
- DSH SDK minimal profile uses an explicitly chosen home and persistent JSONL
  sessions. It does not automatically inherit all plugins/tools from a GUI home;
  select the intended profile and permissions, not a hidden isolated replacement.

## Connection paths

Tool direction:

    Harness MCP client -> WishOS MCP -> paired device RPC -> system service

Device direction:

    device system AI request -> selected connector/session ingress -> Harness
    Harness -> WishOS MCP -> typed result/resources -> device system -> application

Local path:

    device -> paired user connector (LAN WS/RPC)

Fallback path:

    device -> outbound WSS -> relay <- outbound WSS <- user connector

A vendor-cloud MCP client can reach hosted MCP without a local host for device
control. Running a local Harness still needs its machine awake. A browser on the
same Wi-Fi does not make cloud-executed MCP calls local. Only an executing local
connector can use the LAN shortcut. This is relay-based NAT traversal, not a
claim of universal peer-to-peer hole punching.

Keep stable device and connector IDs plus scoped pairing grants. Use mDNS and
stable `.local` hostnames to avoid fixed DHCP; manual addresses are optional.
Advertise a `_wishos._tcp` service from a connector. The connector returns a
paired endpoint profile, including its stable hostname and relay endpoint.
The firmware owner has implemented ordered endpoints in `/services/link`. Do not invent another device protocol; retain
`wishos-rpc/1`, boot IDs, operation IDs and existing bounded frame transport.
Do not replay an uncertain mutating command just because the route changed.

The firmware-facing confirmed configuration is:

    /services/link configure {
      settings: {
        enabled: true,
        endpoints: [
          { id:"lan", host:"wishos-<connector>.local", port:18762,
            path:"/os/device?id=<device>", tls:false, headers:{Authorization:"Bearer <pairing-grant>"} },
          { id:"relay", host:"relay.wishos.dev", port:443,
            path:"/os/device?id=<device>", tls:true, verify_peer:true,
            headers:{Authorization:"Bearer <pairing-grant>"} }
        ]
      }, persist:true
    }

Ports/hostnames are profile data, not OS constants. Root/terminal owner controls
final schema and routing behavior; server task must not edit firmware itself.
Relays/receivers authenticate pairing scope; cloud never accepts a model-provider
key field. HTTP MCP payloads terminate at the MCP service, so claim no transcript
persistence, not that the server cannot see any request bytes. TLS is not E2EE.

## Ordered result contract

The confirmed result/2 contract replaces the old target fields with an
ordered action sequence. Each step belongs to application or system; steps may
alternate freely. The terminal owns execution and receiver/lifecycle semantics.
Do not extend the old single-effect result format. See device-link-contract.md
and the parent's confirmed wishos-result/2 interface before publishing integration.

## Session and data ownership

- Native Harness session IDs are scoped to adapter + execution host + profile.
  Keep a device binding reference and operation receipts, not a second canonical
  chat log that can diverge from the Harness.
- Followup voice goes through `steer` when the adapter supports active-turn
  steering; otherwise use its documented queue/next-turn behavior and expose that
  fact. Never fake steer by spawning an unrelated session or killing a turn.
- Provider/account credentials remain with the user-owned runner. A desktop
  subscription, model API key and scoped WishOS pairing grant are different things.
- ASR is an independent capability: use a supported Harness speech path or a
  user-configured ASR provider on the user's host. MCP compatibility alone does
  not imply audio transcription. Do not upload provider tokens to the relay.
- Artifact fetch/render/index happens upstream. Cloud relay buffers are bounded
  and ephemeral; local artifact storage and recording retention are explicit user
  policies. Reconcile interrupted transfers and terminal effects using existing
  request IDs and digests. No duplicate installation on LAN/relay handover.

## Deliverables for the forked server task

1. Independent private GitHub repo with MIT license and preserved Hub history.
2. Rename/refactor package entrypoints around WishOS; pin dependencies and maintain
   one standard MCP tool/resource contract across supported client transports.
3. User connector, browser setup wizard, client config exports and session-capability
   checks. A missing executable or unapproved vendor OAuth app is a clear external
   prerequisite, not a simulated supported mode.
4. Appropriate documented adapters for Codex, Claude Code, DSH, Cursor, WorkBuddy,
   OpenClaw and Hermes; generic ChatGPT remote-MCP support with its reverse-trigger
   limitation. Keep unverified real-provider status distinct from fixtures.
5. Hosted MCP/pairing/relay deployment under mcp.wishos.dev and relay.wishos.dev,
   tenant/scoped authorization, bounded buffers, no model key intake or transcript
   persistence. Reuse the existing Cloudflare account; do not alter telemetry.
6. Reproducible self-host release/launchers, no Docker Compose dependency. Start a
   local web wizard; a full Electron app is not needed for the first release.
7. Tests for protocol versions, trigger receipts, credentials staying local,
   pairing isolation, LAN/relay handover, uncertain mutation reconciliation,
   offline/expired hosts, multi-file delivery and cleanup. Release smoke tests on
   supported platforms. No claim of live vendor acceptance without credentials.

## Primary sources read

- ChatGPT/Codex MCP: https://learn.chatgpt.com/docs/extend/mcp
- ChatGPT plugin connection: https://developers.openai.com/plugins/build/app-quickstart
- Codex app-server: https://learn.chatgpt.com/docs/app-server
- Claude channels: https://code.claude.com/docs/en/channels
- Claude channel wire/ACK behavior: https://code.claude.com/docs/en/channels-reference
- Claude SDK/headless: https://code.claude.com/docs/en/headless
- DSH: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/mcp.md
- DSH session controls: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md
- DSH Python SDK: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md
- WorkBuddy MCP/OAuth: https://open.workbuddy.cn/docs/connector
- WorkBuddy messaging/ACP: https://open.workbuddy.cn/docs/openapi
- Cursor MCP: https://cursor.com/docs/mcp
- Cursor CLI/ACP/session resume: https://cursor.com/docs/cli/using
- Cursor cloud API: https://cursor.com/docs/cloud-agent/api/endpoints
- OpenClaw Gateway/OpenResponses: https://docs.openclaw.ai/gateway/openresponses-http-api
- Hermes API and ownership rules: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- OpenAI API state: https://developers.openai.com/api/docs/guides/conversation-state
- Anthropic state: https://platform.claude.com/docs/en/claude_api_primer
- Gemini API: https://ai.google.dev/api
- MCP current revision: https://modelcontextprotocol.io/specification/2026-07-28
- MCP changes: https://modelcontextprotocol.io/specification/2026-07-28/changelog
