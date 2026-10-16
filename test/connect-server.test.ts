import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, devicePairingToken } from '../src/connect/config.js';
import { ConnectorServer } from '../src/connect/server.js';
import { WireDevice, eventually } from './fixtures/wire-device.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wishos-connector-')),
    settings = new ConfigStore(root);
  const cfg = await settings.load();
  await settings.save({
    ...cfg,
    port: 0,
    mdns: false,
    devices: [{ id: 'device', label: 'Device', token: devicePairingToken(cfg, 'device') }],
  });
  const server = new ConnectorServer(settings, { mdns: false });
  const { url, port } = await server.start();
  const config = await settings.load();
  return {
    root,
    settings,
    server,
    url,
    port,
    config,
    async close() {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function api(f: Awaited<ReturnType<typeof fixture>>, path: string, body?: unknown) {
  const response = await fetch(f.url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + f.config.localToken, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
test('initialization is race-safe and the setup UI never exports cloud/connector secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wishos-create-'));
  try {
    const [a, b] = await Promise.all([new ConfigStore(root).load(), new ConfigStore(root).load()]);
    assert.equal(a.localToken, b.localToken);
    assert.equal(a.pairingSeed, b.pairingSeed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const f = await fixture();
  try {
    assert.equal((await fetch(f.url + '/setup/api/state')).status, 401);
    const page = await fetch(f.url),
      cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const state = await (
      await fetch(f.url + '/setup/api/state', { headers: { Cookie: cookie } })
    ).json();
    const text = JSON.stringify(state);
    assert(!text.includes(f.config.localToken));
    assert(!text.includes(f.config.pairingSeed));
    assert(!text.includes(f.config.devices[0]!.token));
    assert((await page.text()).includes('WishOS 连接器'));
  } finally {
    await f.close();
  }
});
test('native LAN RPC, receipt replay, lost acknowledgement and boot replacement use one identity', async () => {
  const f = await fixture(),
    device = new WireDevice();
  try {
    await device.connect(
      'ws://127.0.0.1:' + f.port + '/os/device?id=device',
      f.config.devices[0]!.token,
    );
    await eventually(async () => {
      const r = await api(f, '/api/devices');
      return r.body[0].route.online ? r : false;
    });
    const path = '/api/os/devices/device/invoke';
    const missing = await api(f, path, { path: '/dev/fixture', method: 'write', args: {} });
    assert.equal(missing.status, 400);
    assert.equal(device.writes, 0);
    const input = {
      path: '/dev/fixture',
      method: 'write',
      args: { value: 1 },
      request_id: 'write-1',
      expected_boot_id: device.boot,
    };
    assert.equal((await api(f, path, input)).body.ok, true);
    assert.equal((await api(f, path, input)).body.ok, true);
    assert.equal(device.writes, 1);
    assert.equal((await api(f, path, { ...input, args: { value: 2 } })).status, 400);
    assert.equal(device.writes, 1);
    device.handler = () => {
      device.socket.terminate();
      return undefined;
    };
    const uncertain = await api(f, path, { ...input, request_id: 'lost-ack' });
    assert.equal(uncertain.status, 400);
    assert.equal(device.writes, 2);
    device.handler = undefined;
    await device.connect(
      'ws://127.0.0.1:' + f.port + '/os/device?id=device',
      f.config.devices[0]!.token,
    );
    const retry = await api(f, path, { ...input, request_id: 'lost-ack' });
    assert.match(retry.body.error, /unknown/);
    assert.equal(device.writes, 2);
    await device.close();
    device.boot = 'new-boot';
    await device.connect(
      'ws://127.0.0.1:' + f.port + '/os/device?id=device',
      f.config.devices[0]!.token,
    );
    const old = await api(f, path, { ...input, request_id: 'after-reset' });
    assert.equal(old.body.ok, false);
    assert.equal(device.writes, 2);
    const next = await api(f, path, {
      ...input,
      request_id: 'fresh',
      expected_boot_id: device.boot,
    });
    assert.equal(next.body.ok, true);
    assert.equal(device.writes, 3);
  } finally {
    await device.close();
    await f.close();
  }
});
test('a failed competing startup cannot remove the running connector lock', async () => {
  const f = await fixture();
  const other = new ConnectorServer(new ConfigStore(f.root), { mdns: false });
  try {
    await assert.rejects(other.start(), /already_running/);
    await other.close();
    assert.equal(
      JSON.parse(await readFile(join(f.root, 'connector.lock'), 'utf8')).pid,
      process.pid,
    );
    assert.equal((await fetch(f.url + '/healthz')).status, 200);
  } finally {
    await f.close();
  }
});

test('local MCP exposes guidance and runs actual Lua preflight before a wire mutation', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const f = await fixture(),
    device = new WireDevice(),
    client = new Client({ name: 'preflight-local', version: '1' });
  device.descriptions['/sys/runtime'] = {
    methods: 'read,load,validate',
    read_methods: 'read',
    engine: 'lua-5.4.8',
    entry_source_limit_bytes: 4096,
  };
  device.resourceHandler = (c) =>
    c.path === '/sys/runtime' && c.method === 'read' ? { source_limit_bytes: 4096 } : {};
  try {
    await device.connect(
      'ws://127.0.0.1:' + f.port + '/os/device?id=device',
      f.config.devices[0]!.token,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.url + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + f.config.localToken } },
      }),
    );
    const guide: any = await client.callTool({
      name: 'get_guidance',
      arguments: { component_id: 'index' },
    });
    assert(!guide.isError);
    assert(guide.content.some((c: any) => c.type === 'resource_link'));
    const invalid: any = await client.callTool({
      name: 'invoke_resource',
      arguments: {
        device_id: 'device',
        path: '/sys/runtime',
        method: 'load',
        args: { source: 'return {' },
        expected_boot_id: device.boot,
        request_id: 'bad-load',
      },
    });
    assert.equal(invalid.isError, true);
    const rejected = JSON.parse(invalid.content[0].text);
    assert.equal(rejected.result.not_dispatched, true);
    assert(!device.calls.some((c) => c.method === 'load'));
    const staged: any = await client.callTool({
      name: 'stage_resource',
      arguments: { text: 'local a <const> = 1; return a' },
    });
    const id = JSON.parse(staged.content[0].text).id;
    const asset = await eventually(async () => {
      const r: any = await client.callTool({ name: 'read_resource_job', arguments: { id } });
      const j = JSON.parse(r.content[0].text);
      return j.state === 'completed' ? j.result : false;
    });
    const checked: any = await client.callTool({
      name: 'preflight_bundle',
      arguments: {
        files: [{ path: 'test.lua', artifact_id: asset.id }],
        device_id: 'device',
        expected_boot_id: device.boot,
      },
    });
    const checkId = JSON.parse(checked.content[0].text).id;
    const report = await eventually(async () => {
      const r: any = await client.callTool({
        name: 'read_resource_job',
        arguments: { id: checkId },
      });
      const j = JSON.parse(r.content[0].text);
      if (j.state === 'failed') throw Error(JSON.stringify(j));
      return j.state === 'completed' ? j.result : false;
    });
    assert.equal(report.lua.parser, 'Lua 5.4.8');
    assert(!device.calls.some((c) => ['begin', 'load', 'mounts'].includes(c.method)));
  } finally {
    await client.close();
    await device.close();
    await f.close();
  }
});

test('local MCP package admission and device-selected component discovery use the public transport', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client'),
    { PackageDevice } = await import('./fixtures/package-device.js');
  const f = await fixture(),
    wire = new WireDevice(),
    native = new PackageDevice(),
    client = new Client({ name: 'package-local', version: '1' });
  native.boot = wire.boot;
  native.paginatedMounts = true;
  native.descriptions['/sys/apps'].install_providers = 'card';
  wire.descriptions = native.descriptions;
  wire.board = {
    component_index: { format: 'wishos-components/1', file: '/system/components.json' },
  };
  wire.resourceHandler = (c) => native.call(c);
  native.files.set(
    '/system/components.json',
    Buffer.from(
      JSON.stringify({
        format: 'wishos-components/1',
        components: [
          {
            id: 'custom-device',
            layer: 'driver',
            kind: 'device',
            source: { repository: 'https://github.com/fixture/board', path: 'hardware' },
          },
        ],
      }),
    ),
  );
  const call = async (name: string, args: any) => {
    const r: any = await client.callTool({ name, arguments: args });
    assert(!r.isError, JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  };
  const finish = async (id: string) =>
    eventually(async () => {
      const job = await call('read_resource_job', { id });
      if (['failed', 'unknown'].includes(job.state)) throw Error(JSON.stringify(job));
      return job.state === 'completed' ? job.result : false;
    });
  const stage = async (path: string, text: string) => ({
    path,
    artifact_id: (await finish((await call('stage_resource', { text })).id)).id,
  });
  try {
    await wire.connect(
      'ws://127.0.0.1:' + f.port + '/os/device?id=device',
      f.config.devices[0]!.token,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.url + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + f.config.localToken } },
      }),
    );
    const index = await call('get_device_components', {
      device_id: 'device',
      expected_boot_id: wire.boot,
    });
    assert.equal(index.components[0].id, 'custom-device');
    const files = [
      await stage(
        'app.json',
        JSON.stringify({
          format: 'wishos-app/1',
          id: 'local-app',
          title: 'Local',
          entry: 'main.lua',
        }),
      ),
      await stage('main.lua', 'return {}'),
    ];
    const p = await finish(
      (await call('prepare_package', { device_id: 'device', expected_boot_id: wire.boot, files }))
        .id,
    );
    native.pendingApplication = 'boot-launcher';
    const blockedRequest = await call('deploy_package', {
      device_id: 'device',
      expected_boot_id: wire.boot,
      files: p.files,
      activate: true,
      stop_current_before_transfer: true,
    });
    const blocked = await eventually(async () => {
      const job = await call('read_resource_job', { id: blockedRequest.id });
      return job.state === 'failed' ? job : false;
    });
    assert.match(blocked.error, /application_transition_pending/);
    assert.equal(native.pendingApplication, 'boot-launcher');
    assert.equal(native.active, 'original');
    assert(!native.calls.some((c) => ['stop', 'mount', 'begin'].includes(c.method)));
    native.pendingApplication = undefined;
    wire.beforeRespond = (c) => {
      if (c.path === '/sys/runtime' && c.method === 'stop')
        native.pendingApplication = 'late-selection';
    };
    const nativeRequest = await call('deploy_package', {
      device_id: 'device',
      expected_boot_id: wire.boot,
      files: p.files,
      activate: true,
      stop_current_before_transfer: true,
    });
    const nativeRefusal = await eventually(async () => {
      const job = await call('read_resource_job', { id: nativeRequest.id });
      return job.state === 'failed' ? job : false;
    });
    assert.equal(nativeRefusal.error, 'application_transition_pending');
    assert.equal(nativeRefusal.receipts.runtime_stop.ok, false);
    assert.equal(nativeRefusal.receipts.runtime_stop.error, 'application_transition_pending');
    assert.equal(native.active, 'original');
    assert.equal(native.pendingApplication, 'late-selection');
    assert.equal(
      native.calls.filter((c) => c.path === '/sys/runtime' && c.method === 'stop').length,
      1,
    );
    assert(!native.calls.some((c) => c.method === 'mount' || c.method === 'begin'));
    wire.beforeRespond = undefined;
    native.pendingApplication = undefined;
    const result = await finish(
      (
        await call('deploy_package', {
          device_id: 'device',
          expected_boot_id: wire.boot,
          files: p.files,
          activate: true,
        })
      ).id,
    );
    assert.equal(result.state, 'activated');
    assert.equal(native.active, 'local-app');
    assert(!native.calls.some((c) => c.path === '/dev/media' && c.method === 'mount'));
    assert.equal(native.ticket, undefined);
    native.preparationNeedsIdle = true;
    const replaced = await stage('main.lua', 'return {version=2}');
    const updated = await finish(
      (
        await call('update_package', {
          device_id: 'device',
          expected_boot_id: wire.boot,
          application_id: 'local-app',
          expected_revision: 1,
          replacements: [replaced],
          activate: true,
          stop_current_before_transfer: true,
        })
      ).id,
    );
    assert.equal(updated.state, 'activated');
    assert.equal(updated.receipts.runtime_stop.loaded, false);
    const mounted = native.calls.findIndex((c) => c.path === '/dev/media' && c.method === 'mount');
    assert(mounted >= 0);
    assert(
      native.calls
        .slice(mounted + 1)
        .some((c) => c.path === '/fs' && c.method === 'mounts' && c.args.cursor === 4),
    );
    assert.equal(native.revision, 2);
    assert(
      native.calls.some((c) => c.path === '/fs' && c.method === 'mounts' && c.args.cursor === 4),
    );
  } finally {
    await client.close();
    await wire.close();
    await f.close();
  }
});
