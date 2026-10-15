import { ConfigStore, devicePairingToken } from '../src/connect/config.js';
import { ConnectorServer } from '../src/connect/server.js';
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernHttp,
} from '@modelcontextprotocol/client';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHttp } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WireDevice, TransferFixture, eventually } from './fixtures/wire-device.js';
let root: string,
  port: number,
  base: string,
  child: ChildProcess,
  clientIp = 1;
async function launch() {
  child = spawn(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'dev',
      '--local',
      '--config',
      'cloud/wrangler.jsonc',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--var',
      'PUBLIC_ORIGIN:' + base,
      '--var',
      'RELAY_ORIGIN:' + base,
      '--persist-to',
      root,
    ],
    {
      cwd: resolve('.'),
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  await eventually(async () => {
    try {
      return (await fetch(base + '/healthz')).ok;
    } catch {
      return false;
    }
  }, 40000);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = once(child, 'exit');
  if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGTERM');
  else child.kill('SIGTERM');
  await done;
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wishos-cloud-'));
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  base = 'http://127.0.0.1:' + port;
  await launch();
});
after(async () => {
  await stop();
  await rm(root, { recursive: true, force: true });
});
async function request(path: string, body?: unknown, token?: string) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.' + clientIp++,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function installation() {
  const id = randomUUID(),
    seed = randomBytes(32).toString('base64url');
  const body = {
    id,
    label: 'Fixture',
    hostname: 'wishos-fixture.local',
    port: 18762,
    pairing_seed: seed,
  };
  const created = await request('/v1/installations', body);
  assert.equal(created.status, 201);
  return { ...created.body, input: body };
}
async function access(owner: string) {
  const r = await request('/v1/access', {}, owner);
  assert.equal(r.status, 200);
  return r.body.token as string;
}
async function connectMcp(token: string) {
  const client = new LegacyClient({ name: 'fixture-old', version: '1' });
  await client.connect(
    new LegacyHttp(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }),
  );
  return client;
}
test('pairing credentials are idempotent, scoped and cannot become provider-key storage', async () => {
  const a = await installation(),
    b = await installation();
  try {
    const again = await request('/v1/installations', a.input);
    assert.equal(again.body.owner_token, a.owner_token);
    assert.equal(again.body.connector_token, a.connector_token);
    const wrong = await request('/v1/installations', {
      ...a.input,
      pairing_seed: randomBytes(32).toString('base64url'),
    });
    assert.equal(wrong.status, 409);
    const rejected = await request('/v1/installations', {
      ...a.input,
      id: randomUUID(),
      api_key: 'not-accepted',
    });
    assert.equal(rejected.status, 400);
    const profile = await request('/v1/devices', { id: 'screen', label: 'Screen' }, a.owner_token);
    assert.equal(profile.status, 201);
    const stable = await request('/v1/devices/profile', { id: 'screen' }, a.owner_token);
    assert.equal(stable.body.token, profile.body.token);
    const code = await request(
      '/v1/pair/code',
      { purpose: 'device', device_id: 'screen' },
      a.owner_token,
    );
    const claimed = await request('/v1/pair/claim', { code: code.body.code });
    assert.equal(claimed.body.token, profile.body.token);
    assert.equal((await request('/v1/pair/claim', { code: code.body.code })).status, 400);
    const wrongScope = await request(
      '/v1/devices',
      { id: 'bad', label: 'Bad' },
      profile.body.token,
    );
    assert.equal(wrongScope.status, 401);
    const mcp = await connectMcp(await access(b.owner_token));
    try {
      const result = await mcp.callTool({
        name: 'device_state',
        arguments: { device_id: 'screen' },
      });
      assert.equal(result.isError, true);
    } finally {
      await mcp.close();
    }
  } finally {
    for (const x of [a, b])
      await fetch(base + '/v1/installations', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + x.owner_token },
      });
  }
});
test('OAuth PKCE consumes grants once, keeps refresh client-bound and exposes supported protocol discovery', async () => {
  const a = await installation();
  try {
    const metadata = await request('/.well-known/oauth-authorization-server');
    assert.equal(metadata.body.issuer, base);
    const registered = await request('/oauth/register', {
      client_name: 'Test <client>',
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
    });
    assert.equal(registered.status, 201);
    const pairing = await request('/v1/pair/code', { purpose: 'mcp' }, a.owner_token);
    const verifier = randomBytes(32).toString('base64url'),
      challenge = createHash('sha256').update(verifier).digest('base64url');
    const parameters = new URLSearchParams({
      response_type: 'code',
      client_id: registered.body.client_id,
      redirect_uri: 'http://127.0.0.1:35235/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'wishos:devices',
      state: 'kept',
      pairing_code: pairing.body.code,
      consent: 'connect',
    });
    const auth = await fetch(base + '/oauth/authorize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: base,
        'CF-Connecting-IP': '203.0.113.' + clientIp++,
      },
      body: parameters,
      redirect: 'manual',
    });
    assert.equal(auth.status, 302);
    const location = new URL(auth.headers.get('location')!);
    assert.equal(location.searchParams.get('iss'), base);
    assert.equal(location.searchParams.get('state'), 'kept');
    const exchange = new URLSearchParams({
      grant_type: 'authorization_code',
      code: location.searchParams.get('code')!,
      client_id: registered.body.client_id,
      redirect_uri: parameters.get('redirect_uri')!,
      code_verifier: verifier,
    });
    const tokens = await (
      await fetch(base + '/oauth/token', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.' + clientIp++ },
        body: exchange,
      })
    ).json();
    assert(tokens.access_token);
    assert(tokens.refresh_token);
    const reused = await fetch(base + '/oauth/token', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.' + clientIp++ },
      body: exchange,
    });
    assert.equal(reused.status, 400);
    const refresh = async (client: string) =>
      fetch(base + '/oauth/token', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.' + clientIp++ },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: client,
          refresh_token: tokens.refresh_token,
        }),
      });
    assert.equal((await refresh('wrong-client')).status, 400);
    assert.equal((await refresh(registered.body.client_id)).status, 200);
    assert.equal((await refresh(registered.body.client_id)).status, 400);
    const client = await connectMcp(tokens.access_token);
    try {
      assert((await client.listTools()).tools.some((t) => t.name === 'invoke_resource'));
    } finally {
      await client.close();
    }
    const modern = new ModernClient(
      { name: 'modern-fixture', version: '1' },
      {
        supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );
    try {
      await modern.connect(
        new ModernHttp(new URL(base + '/mcp'), {
          requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } },
        }),
      );
      assert.equal(modern.getNegotiatedProtocolVersion(), '2026-07-28');
      assert((await modern.listTools()).tools.some((t) => t.name === 'invoke_resource'));
    } finally {
      await modern.close();
    }
  } finally {
    await fetch(base + '/v1/installations', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + a.owner_token },
    });
  }
});
test('cloud device RPC never replays a write after a lost response or Worker restart', async () => {
  const a = await installation();
  const profile = await request('/v1/devices', { id: 'device', label: 'Device' }, a.owner_token);
  const device = new WireDevice(),
    token = await access(a.owner_token);
  let client = await connectMcp(token);
  try {
    await device.connect(base.replace('http:', 'ws:') + '/os/device?id=device', profile.body.token);
    await eventually(async () => {
      const r: any = await client.callTool({
        name: 'device_state',
        arguments: { device_id: 'device' },
      });
      return JSON.parse(r.content[0].text).online;
    });
    const input = {
      device_id: 'device',
      path: '/dev/fixture',
      method: 'write',
      args: { value: 1 },
      request_id: 'normal',
      expected_boot_id: device.boot,
    };
    assert.equal(
      (await client.callTool({ name: 'invoke_resource', arguments: input })).isError,
      false,
    );
    await client.callTool({ name: 'invoke_resource', arguments: input });
    assert.equal(device.writes, 1);
    device.handler = () => undefined;
    const pending = client
      .callTool(
        {
          name: 'invoke_resource',
          arguments: { ...input, request_id: 'crash-after-write' },
        },
        undefined,
        { timeout: 3000 },
      )
      .catch(() => undefined);
    await eventually(async () => device.writes === 2);
    await stop();
    await pending;
    await client.close();
    await launch();
    device.handler = undefined;
    await device.connect(base.replace('http:', 'ws:') + '/os/device?id=device', profile.body.token);
    client = await connectMcp(token);
    const retry: any = await client.callTool({
      name: 'invoke_resource',
      arguments: { ...input, request_id: 'crash-after-write' },
    });
    assert.equal(retry.isError, true);
    assert.match(retry.content[0].text, /unknown|reconcile/i);
    assert.equal(device.writes, 2);
    assert.equal(
      (
        await client.callTool({
          name: 'invoke_resource',
          arguments: { ...input, request_id: 'independent' },
        })
      ).isError,
      false,
    );
    assert.equal(device.writes, 3);
  } finally {
    await client.close();
    await device.close();
    await fetch(base + '/v1/installations', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + a.owner_token },
    });
  }
});
test('cloud stages temporary assets as jobs, preserves source hash and rejects repeated IDs with different content', async () => {
  const a = await installation(),
    client = await connectMcp(await access(a.owner_token));
  try {
    const input = { text: '{"format":"example","content":"中文"}', request_id: 'asset-job' };
    const submitted: any = await client.callTool({ name: 'stage_resource', arguments: input });
    assert(!submitted.isError, JSON.stringify(submitted));
    const job = JSON.parse(submitted.content[0].text);
    assert.equal(job.id, 'asset-job');
    const completed = await eventually(async () => {
      const r: any = await client.callTool({
        name: 'read_resource_job',
        arguments: { id: job.id },
      });
      const j = JSON.parse(r.content[0].text);
      return j.state === 'completed' ? j : false;
    });
    assert.equal(completed.result.sha256, createHash('sha256').update(input.text).digest('hex'));
    assert.equal(completed.result.size, Buffer.byteLength(input.text));
    const conflict: any = await client.callTool({
      name: 'stage_resource',
      arguments: { ...input, text: 'different' },
    });
    assert.equal(conflict.isError, true);
  } finally {
    await client.close();
    await fetch(base + '/v1/installations', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + a.owner_token },
    });
  }
});

test('cloud resource jobs stream a verified staged bundle over the real relay wire', async () => {
  const a = await installation(),
    client = await connectMcp(await access(a.owner_token)),
    device = new WireDevice(),
    transfer = new TransferFixture();
  device.resourceHandler = (c) => transfer.call(c);
  try {
    const profile = await request('/v1/devices', { id: 'device', label: 'Device' }, a.owner_token);
    await device.connect(base.replace('http:', 'ws:') + '/os/device?id=device', profile.body.token);
    const call = async (name: string, args: any) => {
      const r: any = await client.callTool({ name, arguments: args });
      assert(!r.isError, JSON.stringify(r));
      return JSON.parse(r.content[0].text);
    };
    const submitted = await call('stage_resource', { text: '书籍内容'.repeat(1000) });
    const asset = await eventually(async () => {
      const j = await call('read_resource_job', { id: submitted.id });
      return j.state === 'completed' ? j.result : false;
    });
    const delivery = await call('deliver_resources', {
      device_id: 'device',
      expected_boot_id: device.boot,
      files: [{ path: 'book.txt', artifact_id: asset.id }],
    });
    const done = await eventually(async () => {
      const j = await call('read_resource_job', { id: delivery.id });
      if (j.state === 'failed' || j.state === 'unknown') throw Error(JSON.stringify(j));
      return j.state === 'completed' ? j : false;
    }, 20000);
    assert.equal(done.result.transfer_id, 1);
    assert(transfer.committed);
    assert.equal(createHash('sha256').update(transfer.received).digest('hex'), asset.sha256);
  } finally {
    await client.close();
    await device.close();
    await fetch(base + '/v1/installations', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + a.owner_token },
    });
  }
});

test('cloud MCP follows authenticated connector to a LAN device and retains mutation receipts', async () => {
  const a = await installation(),
    root = await mkdtemp(join(tmpdir(), 'wishos-live-host-')),
    settings = new ConfigStore(root),
    cfg = await settings.load();
  const deviceToken = (
    await request('/v1/devices', { id: 'device', label: 'Device' }, a.owner_token)
  ).body.token;
  await settings.save({
    ...cfg,
    port: 0,
    mdns: false,
    cloudRoomId: a.room_id,
    pairingSeed: a.input.pairing_seed,
    cloud: {
      endpoint: base,
      relayEndpoint: base,
      roomId: a.room_id,
      ownerToken: a.owner_token,
      connectorToken: a.connector_token,
    },
    devices: [{ id: 'device', label: 'Device', token: deviceToken }],
  });
  const server = new ConnectorServer(settings, { mdns: false }),
    { port } = await server.start(),
    device = new WireDevice(),
    client = await connectMcp(await access(a.owner_token));
  try {
    await device.connect('ws://127.0.0.1:' + port + '/os/device?id=device', deviceToken);
    const call = async (name: string, args: any) => {
      const r: any = await client.callTool({ name, arguments: args });
      assert(!r.isError, JSON.stringify(r));
      return JSON.parse(r.content[0].text);
    };
    await eventually(async () => {
      const s = await call('device_state', { device_id: 'device' });
      return s.route?.route === 'lan' ? s : false;
    });
    const input = {
      device_id: 'device',
      path: '/dev/fixture',
      method: 'write',
      args: { value: 1 },
      expected_boot_id: device.boot,
      request_id: 'nested-write',
    };
    assert((await call('invoke_resource', input)).ok);
    await call('invoke_resource', input);
    assert.equal(device.writes, 1);
  } finally {
    await client.close();
    await device.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
    await fetch(base + '/v1/installations', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + a.owner_token },
    });
  }
});
