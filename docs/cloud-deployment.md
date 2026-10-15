# Cloud deployment

The Worker in `cloud/` owns scoped pairing, OAuth, remote MCP and WS relay. It does
not execute models or persist authoritative chat history. Two SQLite Durable
Object classes hold directory/grants and per-installation routing/receipts.
Temporary resource chunks expire after one hour; R2 is not required. Worker body
logs, traces and logpush are disabled.

Use your own Cloudflare account and zone:

```sh
npm ci
npm run check:cloud
npm run cloud:bundle
npx wrangler login
npm run cloud:deploy
```

Edit `cloud/wrangler.jsonc` origins/custom domains to your deployment. Keep both
origins HTTPS/WSS in production. Wrangler creates `WishosDirectory` and
`WishosRoom` with the versioned SQLite migration. It must not modify an existing
telemetry service. Do not attach MCP to another application's Worker.

The initial browser setup runs on the user's host. Enabling cloud creates a
stable installation and independent owner/connector grants; then add devices and
generate short-lived purpose-bound device or MCP codes. An identical bootstrap
retry with the same pairing seed recovers the same grants. Other callers cannot
replace that installation. Codes are consumed once; OAuth uses PKCE, client-bound
refresh rotation and explicit consent. Provider keys are not accepted fields.

For custom remote MCP clients, use `https://mcp.wishos.dev/mcp` (or your origin).
Discovery metadata is at `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server`. Local clients can instead use stdio
without enabling the relay. A cloud client cannot infer LAN reachability from the
browser; executing local connectors make that decision.

Authenticated deployment smoke (no real device/Harness required):

```sh
node --import tsx scripts/check-deployment.ts https://mcp.wishos.dev
```

This creates and deletes only a uniquely named synthetic installation and fake
wire device. It validates real HTTPS, OAuth metadata, authorization scope, device
WS and MCP RPC, resource staging and mutation identity. It does not prove a
physical panel refreshed or that a vendor account authorized native ingress.

Cloud resource receipts survive process restart. Unfinished mutations are marked
unknown and are never replayed automatically. Host resource jobs have equivalent
receipts and cancellation; repeated explicit resource IDs reconcile the original
job. Physical/native completion remains a terminal resource contract.
