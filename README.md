# Agentic Notes server and MCP

This is an independent repository. It contains the existing Harness adapters,
voice codec/ASR routing, rendering service and the public AgenticOS MCP/relay.
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

AgenticOS microphone blocks use the same independently decodable IMA ADPCM packet
codec as the existing voice pipeline. `os-audio.ts` validates OS chunk metadata,
preserves compressed packets, and decodes only when a PCM consumer requires it.
Complete OS-to-Hub voice streaming remains an integration step; configuring an
endpoint does not imply an authenticated/connected session.

Run `npm test`. This repository does not contain firmware, PCB or waveform research.
