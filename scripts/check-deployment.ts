import { PackageDevice } from '../test/fixtures/package-device.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WireDevice, TransferFixture, eventually } from '../test/fixtures/wire-device.js';
const base = new URL(process.argv[2] ?? 'https://mcp.wishos.dev').origin;
async function api(path: string, body?: unknown, token?: string) {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const v = (await r.json()) as any;
  if (!r.ok) throw Error(path + ': ' + r.status + ' ' + JSON.stringify(v));
  return v;
}
const health = await api('/healthz');
assert(health.ok);
const metadata = await api('/.well-known/oauth-authorization-server');
assert.equal(metadata.issuer, base);
const id = randomUUID();
let owner: string | undefined;
const device = new WireDevice(),
  transfer = new TransferFixture(1024);
let client: Client | undefined;
try {
  const install = await api('/v1/installations', {
    id,
    label: 'Deployment check',
    hostname: 'wishos-check.local',
    port: 18762,
    pairing_seed: randomBytes(32).toString('base64url'),
  });
  owner = install.owner_token;
  const profile = await api(
    '/v1/devices',
    { id: 'test-device', label: 'Synthetic wire fixture' },
    owner,
  );
  const token = (await api('/v1/access', {}, owner)).token;
  client = new Client(
    { name: 'wishos-release-check', version: '1' },
    {
      supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }),
  );
  const call = async (name: string, args: any) => {
    const r: any = await client!.callTool({ name, arguments: args });
    assert(!r.isError, JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  };
  const relay = new URL(install.relay_origin);
  relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
  relay.pathname = '/os/device';
  relay.search = '?id=test-device';
  device.resourceHandler = (c) => transfer.call(c);
  await device.connect(relay.toString(), profile.token);
  await eventually(
    async () => (await call('device_state', { device_id: 'test-device' })).online,
    20000,
  );
  const input = {
    device_id: 'test-device',
    path: '/dev/fixture',
    method: 'write',
    args: { value: 1 },
    expected_boot_id: device.boot,
    request_id: 'check-write',
  };
  assert((await call('invoke_resource', input)).ok);
  await call('invoke_resource', input);
  assert.equal(device.writes, 1);
  const receipt = await call('read_operation', {
    device_id: 'test-device',
    boot_id: device.boot,
    request_id: 'check-write',
  });
  assert.equal(receipt.state, 'returned');
  const job = await call('stage_resource', { text: 'WishOS resource check 中文 '.repeat(400) });
  const asset = await eventually(async () => {
    const j = await call('read_resource_job', { id: job.id });
    if (j.state === 'failed') throw Error(j.error);
    return j.state === 'completed' ? j.result : false;
  }, 20000);
  const delivery = await call('deliver_resources', {
    device_id: 'test-device',
    expected_boot_id: device.boot,
    files: [{ path: 'check.txt', artifact_id: asset.id }],
  });
  await eventually(async () => {
    const j = await call('read_resource_job', { id: delivery.id });
    if (['failed', 'unknown'].includes(j.state)) throw Error(JSON.stringify(j));
    return j.state === 'completed';
  }, 60000);
  assert(transfer.committed);
  assert.equal(createHash('sha256').update(transfer.received).digest('hex'), asset.sha256);
  const native = new PackageDevice();
  native.boot = device.boot;
  device.descriptions = native.descriptions;
  device.board = {
    component_index: { format: 'wishos-components/1', file: '/system/components.json' },
  };
  device.resourceHandler = (c) => native.call(c);
  native.files.set(
    '/system/components.json',
    Buffer.from(
      JSON.stringify({
        format: 'wishos-components/1',
        components: [{ id: 'deployment-fixture', layer: 'driver', kind: 'device' }],
      }),
    ),
  );
  const finish = async (id: string) =>
    eventually(async () => {
      const j = await call('read_resource_job', { id });
      if (['failed', 'unknown'].includes(j.state)) throw Error(JSON.stringify(j));
      return j.state === 'completed' ? j.result : false;
    }, 60000);
  const stage = async (path: string, text: string) => ({
    path,
    artifact_id: (await finish((await call('stage_resource', { text })).id)).id,
  });
  const index = await call('get_device_components', {
    device_id: 'test-device',
    expected_boot_id: device.boot,
  });
  assert.equal(index.components[0].id, 'deployment-fixture');
  const bad = await stage('bad.lua', 'local = 1');
  const badJob = await call('preflight_bundle', {
    files: [bad],
    device_id: 'test-device',
    expected_boot_id: device.boot,
  });
  const rejected = await eventually(async () => {
    const j = await call('read_resource_job', { id: badJob.id });
    return j.state === 'failed' ? j : false;
  }, 20000);
  assert.equal(rejected.diagnostics[0].code, 'lua_syntax');
  assert(!native.calls.some((c) => c.method === 'begin'));
  const files = [
    await stage(
      'app.json',
      JSON.stringify({
        format: 'wishos-app/1',
        id: 'live-check',
        title: 'Live check',
        entry: 'main.lua',
      }),
    ),
    await stage('main.lua', 'local x <const> = 1; return {version=x}'),
    await stage('image.bin', 'unchanged asset'),
  ];
  const p = await finish(
    (
      await call('prepare_package', {
        device_id: 'test-device',
        expected_boot_id: device.boot,
        files,
      })
    ).id,
  );
  assert.equal(p.preflight.lua.native_call_depth_limit, 32);
  const installed = await finish(
    (
      await call('deploy_package', {
        device_id: 'test-device',
        expected_boot_id: device.boot,
        files: p.files,
        activate: true,
      })
    ).id,
  );
  assert.equal(installed.state, 'activated');
  let readReconnect = false,
    reconnectFailure: unknown;
  device.beforeRespond = async (c) => {
    if (
      !readReconnect &&
      native.revision === 1 &&
      native.ticket?.state === 'validated' &&
      c.path === '/sys/capabilities' &&
      c.args.path === '/sys/apps'
    ) {
      readReconnect = true;
      device.socket.terminate();
      try {
        await device.connect(relay.toString(), profile.token);
      } catch (error) {
        reconnectFailure = error;
      }
      return false;
    }
  };
  const replacement = await stage('main.lua', 'return {version=2}');
  const updated = await finish(
    (
      await call('update_package', {
        device_id: 'test-device',
        expected_boot_id: device.boot,
        application_id: 'live-check',
        expected_revision: 1,
        replacements: [replacement],
      })
    ).id,
  );
  assert.equal(updated.state, 'installed');
  if (reconnectFailure) throw reconnectFailure;
  assert(readReconnect);
  assert.equal(
    native.calls.filter((c) => c.path === '/sys/apps' && c.method === 'install').length,
    2,
  );
  assert.equal(native.revision, 2);
  assert.equal(native.files.get('/card/revisions/2/main.lua')!.toString(), 'return {version=2}');
  assert(!native.reads.has('/card/revisions/1/image.bin'));
  const tool = (await client.listTools()).tools.find((t) => t.name === 'update_package');
  assert.equal((tool!.inputSchema as any).properties.stop_current_before_transfer.default, false);
  native.preparationNeedsIdle = true;
  native.preparationReady = false;
  const explicitReplacement = await stage('main.lua', 'return {version=3}');
  const explicit = await finish(
    (
      await call('update_package', {
        device_id: 'test-device',
        expected_boot_id: device.boot,
        application_id: 'live-check',
        expected_revision: 2,
        replacements: [explicitReplacement],
        activate: true,
        stop_current_before_transfer: true,
      })
    ).id,
  );
  assert.equal(explicit.state, 'activated');
  assert.equal(explicit.receipts.runtime_stop.loaded, false);
  assert.equal(native.revision, 3);
  assert.equal(
    native.calls.filter((c) => c.path === '/sys/runtime' && c.method === 'stop').length,
    1,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        origin: base,
        protocol: client.getNegotiatedProtocolVersion(),
        checks: [
          'https',
          'metadata',
          'paired-wss',
          'mcp-device-rpc',
          'mutation-receipt-no-replay',
          'temporary-assets',
          'streamed-bundle-sha256',
          'mcp-layer-guidance',
          'boot-scoped-components',
          'actual-lua-wasm-profile',
          'bad-code-no-device-write',
          'package-native-ticket-install-activate',
          'whole-file-update-local-copy',
          'explicit-stop-after-preflight-before-preparation',
          'same-boot-read-recovery-before-single-install',
        ],
        physical_device: false,
        vendor_account: false,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  await client?.close();
  await device.close();
  if (owner) {
    const r = await fetch(base + '/v1/installations', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + owner },
      signal: AbortSignal.timeout(20000),
    });
    assert(r.ok, 'Synthetic installation cleanup failed');
  }
}
