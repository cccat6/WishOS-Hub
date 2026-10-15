# WishOS Hub

MCP tools, a user-owned Harness connector and a cloud device relay for WishOS.
This is separate from the [WishOS terminal OS](https://github.com/cccat6/WishOS).
MIT licensed; the repository and preview releases are currently private.

## Run

Download the matching release, extract it and open **WishOS Hub.command** (macOS),
**WishOS Hub.cmd** (Windows), or run **./wishos-hub setup** (Linux). The release
includes Node.js and production dependencies. No Docker, Python or local model is
needed for the connector. The browser wizard manages devices, runtime bindings,
MCP configuration, cloud pairing, online speech recognition and task recovery.

From source, use Node.js 24.22.0:

```sh
npm ci
npm run build
npm run launch
```

The default setup UI is `http://127.0.0.1:18762/`. Use `--port` for a different
port; leave an existing unrelated service alone. The local setup UI is loopback
only. Device WS accepts a separate per-device pairing grant on the LAN listener.

```sh
node dist/connect/cli.js setup --port 18763
node dist/connect/cli.js status
node dist/connect/cli.js export --client codex
node dist/connect/cli.js --stdio
```

Use `--data-dir PATH` or `WISHOS_HOME` to select independent installations. The
stdio entry starts/reuses a connector and writes only MCP protocol to stdout.
Stop a foreground connector with Ctrl-C. Existing settings survive an upgrade;
replace the extracted program, not the data directory.

## Two directions, one tool contract

An Agent calls **WishOS MCP** to discover devices, inspect resource contracts,
invoke system services and stage/deliver assets. Standard MCP does not give a
device permission to start a conversation in every client.

For a device-triggered request, the connector submits to a configured runtime's
own session interface. That runtime performs reasoning and uses WishOS MCP when
it needs the device. Sessions and model credentials remain in that runtime.

| Runtime | Device-trigger adapter in this preview | Session boundary |
| --- | --- | --- |
| Codex | Official app-server | Native thread; native active-turn steer |
| Claude Code | Official headless CLI | New/resumed controlled session; not an attached live TUI |
| DeepSeek Harness | Official ACP profile | Persistent ACP session via `session/resume` |
| Cursor | CLI ACP | CLI session via `session/load`; not editor-chat takeover |
| WorkBuddy | Authorized Open API task ACP | Bind existing task ID; user developer-app authorization required |
| OpenClaw | Opt-in Gateway OpenResponses | Explicit Gateway session key |
| Hermes Agent | API Server Runs | API-owned session; foreign CLI/TUI sessions are refused |
| ChatGPT | Remote MCP tools | ChatGPT owns the chat; no arbitrary reverse-trigger API |

The same MCP tools work through stdio or authenticated HTTPS. A configured
adapter is not proof a particular vendor account has authorized it. See
[the researched integration matrix](docs/integration-architecture.md) for primary
sources and alternate surfaces, including Claude Channels and vendor cloud APIs.
These alternates are not advertised as implemented adapters in this preview.

Users who prefer model APIs run their own existing runner such as OpenClaw or
Hermes. WishOS does not introduce a hosted model-key/session service. These
runners already handle provider-specific APIs, tools and history.

## LAN and Internet

A paired device receives ordered `/services/link` endpoints: a stable `.local`
connector hostname first and outbound WSS relay second. mDNS avoids a fixed DHCP
lease. No inbound router port or UPnP is required. Existing explicit proxy bypass
rules must retain `.local` or the selected LAN hostname.

A **local** connector uses the LAN route when reachable. A cloud-executed MCP
client reaches the cloud relay; a browser on the same Wi-Fi cannot make that
remote execution local. A local Harness still needs its host online. Pairing and
MCP OAuth grants are WishOS credentials, not model-provider credentials.

Cloud deployment instructions: [cloud deployment](docs/cloud-deployment.md).
Current release/deployment evidence: [release notes](docs/release-notes.md).

## Resources, speech and recovery

- Tools discover capabilities before assuming geometry, color spaces, pins,
  completion timing or storage. Native display encodings belong to drivers.
- `stage_resource` starts a job. Poll `read_resource_job` for its artifact ID.
  `prepare_image` runs on the user's host and crops/scales to explicit geometry;
  optional palette indices use the caller's discovered palette. `deliver_resources`
  streams a verified bundle according to the terminal's storage policy. Delivery
  is not application activation or physical display completion.
- Cloud temporary assets are scoped to an installation: 16 MiB per file,
  64 MiB reserved/ready total, one-hour expiry. These are deployment limits, not
  WishOS hardware limits. Large/private resources can stay on the user's host.
  Host cache limits are configured in connector.json resources (file/total bytes
  and TTL); staging reclaims expired/unleased assets and abandoned partial files.
  Image conversion requires the host; simple UI descriptions and prepared binary
  resources can be staged on cloud MCP without it.
- Voice transport uses independently decodable compressed blocks. ASR is an
  independent configured capability: runtime-native when supported, otherwise
  the user's online ASR endpoint. This preview downloads no recognition models.
- Mutation tools require `request_id` and current `expected_boot_id`. A lost
  response does not cause automatic mutation replay on another route. Inspect
  `read_operation` and native completion resources. The local recovery page lists
  unresolved native/Harness outcomes and permits explicit owner reconciliation.
- `wishos-result/2` is an ordered application/system action sequence, not a
  fixed target mode. Receiver processing ACKs, application replacement and native
  BUSY completion belong to the terminal. See [device contract](docs/device-link-contract.md).

The user data directory contains private config, scoped local secrets, host-side
receipts and explicitly staged resources. Model credentials remain with the
runtime. Public cloud stores pairing/auth state, bounded receipts and explicitly
staged temporary files; it does not store authoritative conversation history.
Prompts/audio/provider credentials are not written to cloud logs. TLS terminates
at relay endpoints; this is not a claim of end-to-end encryption.

## Development and validation

```sh
npm test
npm run check:cloud
npm run cloud:bundle
npm run package:release
```

The inherited rendering regression tests use `.venv` plus `requirements.txt`;
Python is a test/legacy-renderer dependency, not a requirement of the released
connector. Firmware and physical-device tests live in the terminal repository.
Host fixtures verify protocol and fault behavior, not live vendor authorization
or physical panel output. See [validation](docs/validation.md).
