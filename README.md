# Agentic Notes server and MCP

This is an independent repository. It contains the existing Harness adapters,
voice codec/ASR routing, rendering service and the public WishOS MCP/relay.
The firmware repository is not required to run it.

```sh
npm ci
npm run build
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
NOTES_OS_URL=http://device-address npm run mcp
```

The public OS tools discover and invoke live resources rather than assuming E6,
GPIOs or a fixed display profile. Discovery follows pagination and checks boot
identity. UI/application assets are uploaded through `/fs`; activation uses runtime
and UI resources. `npm run os-bridge` runs the existing configurable service/Harness
outbox bridge. Its routes and session binding remain application/server policy.

Rendering helpers and licensed fonts are under this repository's `tools/` and
`assets/fonts/`. `NOTES_RENDER_PYTHON` can select another prepared environment.
The existing Hub (`npm run launch`) still owns configured Harness sessions and
voice admission; configuration examples are included. Local tokens, databases,
recordings, caches, credentials and developer probe scripts are not versioned.

WishOS microphone blocks use the same independently decodable IMA ADPCM packet
codec as the existing voice pipeline. `os-audio.ts` validates OS chunk metadata,
preserves compressed packets, and decodes only when a PCM consumer requires it.
OS-to-Hub voice delivery is implemented by `os-voice-route` and `os-audio-ingress`; configuring an endpoint still does not imply a connected session.

Run `npm test`. This repository does not contain firmware, PCB or waveform research.

## WishOS devices

Configure a device with `protocol: "wishos"` (the CLI default). Active devices
configure `/services/link` with `mode:"active"`, host, port, TLS policy and
`path:"/os/device?id=<device-id>"`. Passive devices use `connection:"passive"` and
`deviceUrl:"http://device-ip"`; no separate relay process is needed. Both reach the
same resource API at `/api/os/devices/<id>/invoke` and MCP `/mcp`. The legacy Notes
protocol is explicitly `protocol:"notes"`, with MCP `/mcp/notes` or
`NOTES_PROTOCOL=notes node dist/mcp.js`.

The default WishOS suite submits the `voice` route. Independently decodable ADPCM
blocks receive durable host acknowledgements before the device drops them from
its RAM ring. Optional SD archives can refill dropped blocks using their existing
index. Upload, ASR, Harness admission/steer and physical presentation are distinct
receipts. `audioLimits` configures host compressed/decoded byte limits, concurrent
streams, inactivity timeout and failed-stream retention. Speech settings choose
Harness-native or external online ASR; this does not download a local model.

`os-remote-runner` is for applications providing additional host routes. It uses
`NOTES_OS_JOURNAL` (default `wishos-delivery.sqlite`) to retain side-effect receipts.
A handler may be replayed after an ambiguous transport outcome only when it opts
into `replaySafe` and its upstream service guarantees request-id idempotency.
The journal contains user task results and belongs to deployment data, not Git.
