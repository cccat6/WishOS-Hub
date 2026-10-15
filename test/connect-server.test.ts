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
