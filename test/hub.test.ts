import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
const admin = 'admin-token-for-test-only',
  token = 'device-token-for-test-only';
async function until(fn: () => any) {
  for (let n = 0; n < 200; n++) {
    const v = fn();
    if (v) return v;
    await delay(10);
  }
  throw Error('condition timeout');
}
async function setup(asr?: any, allowPowerCommands = true, deviceToken = token) {
  const store = new Store(':memory:');
  const h = new Hub({
    store,
    adminToken: admin,
    devices: [{ id: 'a', token: deviceToken, adapter: new MockAdapter() }],
    asr,
    allowPowerCommands,
  });
  const address = (await h.listen(0)) as any;
  return {
    h,
    store,
    url: `http://127.0.0.1:${address.port}`,
    ws: `ws://127.0.0.1:${address.port}/device?id=a`,
  };
}
function hello(id = 'a') {
  return {
    type: 'hello',
    protocol: 2,
    device_id: id,
    boot_id: 'boot-1',
    capabilities: { display: true, audio: true, sleep: true, max_scene_bytes: 8192 },
  };
}
async function connect(url: string, greeting: any = hello()) {
  const w = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const inbox: any[] = [];
  w.on('message', (b) => inbox.push(JSON.parse(b.toString())));
  await once(w, 'open');
  w.send(JSON.stringify(greeting));
  await until(() => inbox.some((m) => m.type === 'welcome'));
  return { w, inbox };
}
test('authenticated device dispatch, ack, replacement and admin HTTP', async () => {
  const s = await setup();
  let w: WebSocket | undefined, w2: WebSocket | undefined;
  try {
    assert.equal((await fetch(s.url + '/api/devices')).status, 401);
    const bad = new WebSocket(s.ws, { headers: { Authorization: 'Bearer wrong' } });
    const denied = await new Promise<number>((r) => {
      bad.on('unexpected-response', (_req, res) => {
        r(res.statusCode!);
        res.resume();
        bad.terminate();
      });
      bad.on('error', () => {});
    });
    assert.equal(denied, 401);
    const command = s.h.enqueue('a', {
      request_id: 'one',
      payload: { op: 'builtin', name: 'welcome' },
    });
    assert.equal(command.status, 'queued');
    const c = await connect(s.ws);
    w = c.w;
    await until(() => c.inbox.find((m) => m.type === 'command'));
    w.send(JSON.stringify({ type: 'ack', command_id: command.id, status: 'accepted' }));
    w.send(JSON.stringify({ type: 'ack', command_id: command.id, status: 'completed' }));
    await until(() => s.store.command(command.id)?.status === 'completed');
    w.send(
      JSON.stringify({ type: 'state', state: { power: { vsys_mv: 4100, battery_percent: null } } }),
    );
    await until(() => s.h.state('a').state);
    const response = await fetch(s.url + '/api/devices/a/state', {
      headers: { Authorization: `Bearer ${admin}` },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state.power.battery_percent, null);
    const pending = s.h.enqueue('a', {
      request_id: 'sleep',
      payload: { op: 'sleep', seconds: 60 },
    });
    await until(() => c.inbox.find((m) => m.command_id === pending.id));
    const replacement = await connect(s.ws);
    w2 = replacement.w;
    await until(() => s.store.command(pending.id)?.status === 'uncertain');
    assert.equal(s.h.state('a').online, true);
  } finally {
    w?.terminate();
    w2?.terminate();
    await s.h.close();
    s.store.close();
  }
});
test('voice incomplete never runs ASR; complete voice routes once into persistent session', async () => {
  let calls = 0;
  const s = await setup({
    async transcribe(w: Buffer) {
      calls++;
      assert.equal(w.toString('ascii', 0, 4), 'RIFF');
      return 'hello';
    },
  });
  let w: WebSocket | undefined;
  try {
    const c = await connect(s.ws);
    w = c.w;
    const send = (m: any) => w!.send(JSON.stringify(m));
    const start = (stream_id: string) =>
      send({ type: 'audio.start', stream_id, sample_rate: 16000, channels: 1, sample_bits: 16 });
    start('bad');
    await until(() => c.inbox.find((m) => m.type === 'audio.ready'));
    send({ type: 'audio.end', stream_id: 'bad', chunks: 0, complete: false });
    await until(() => c.inbox.find((m) => m.type === 'audio.error'));
    assert.equal(calls, 0);
    assert.equal(w.readyState, WebSocket.OPEN);
    start('good');
    await until(() => c.inbox.find((m) => m.type === 'audio.ready' && m.stream_id === 'good'));
    assert.throws(() => s.h.startRun('a', { request_id: 'during-audio', text: 'no' }));
    const f = Buffer.alloc(645);
    f[0] = 0x41;
    w.send(f);
    send({ type: 'audio.end', stream_id: 'good', chunks: 1, complete: true });
    await until(() => c.inbox.find((m) => m.type === 'agent.result'));
    assert.equal(calls, 1);
    const native = s.store.session('a', 'mock');
    assert.ok(native);
    const r = s.h.startRun('a', { request_id: 'text', text: 'second' });
    await until(() => s.store.run(r.id).status === 'completed');
    assert.equal(s.store.session('a', 'mock'), native);
    assert.equal(s.h.startRun('a', { request_id: 'text', text: 'second' }).id, r.id);
    assert.throws(() => s.h.startRun('a', { request_id: 'text', text: 'different' }));
  } finally {
    w?.terminate();
    await s.h.close();
    s.store.close();
  }
});
test('claimed device identity cannot cross authenticated binding', async () => {
  const s = await setup();
  const w = new WebSocket(s.ws, { headers: { Authorization: `Bearer ${token}` } });
  try {
    await once(w, 'open');
    const closed = once(w, 'close');
    w.send(JSON.stringify(hello('other')));
    const [code] = await closed;
    assert.equal(code, 1008);
    assert.equal(s.h.state('a').online, false);
  } finally {
    w.terminate();
    await s.h.close();
    s.store.close();
  }
});
test('official MCP client -> stdio bridge -> queued Hub command -> device receipt', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const s = await setup();
  let w: WebSocket | undefined;
  const client = new Client({ name: 'integration-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/mcp.js', import.meta.url))],
    env: { NOTES_HUB_URL: s.url, NOTES_ADMIN_TOKEN: admin },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'present'));
    const r: any = await client.callTool({
      name: 'present',
      arguments: {
        device_id: 'a',
        request_id: 'mcp-page',
        scene: {
          format: 'scene-v1',
          background: 1,
          commands: [{ op: 'text', x: 20, y: 20, color: 0, scale: 2, text: 'Hello' }],
        },
      },
    });
    assert.equal(r.isError, undefined);
    const command = JSON.parse(r.content[0].text);
    assert.equal(command.status, 'queued');
    const greeting = hello();
    const c = await connect(s.ws, {
      ...greeting,
      capabilities: {
        ...greeting.capabilities,
        formats: ['scene-v1', 'nmr1', 'nmp1'],
        max_rle_bytes: 6000,
        max_raster_bytes: 8000,
        fragmented_commands: true,
        refresh_profiles: ['factory', 'fast'],
      },
    });
    w = c.w;
    await until(() => c.inbox.find((m) => m.command_id === command.id));
    w.send(
      JSON.stringify({
        type: 'ack',
        command_id: command.id,
        status: 'completed',
        detail: 'simulated',
      }),
    );
    await until(() => s.store.command(command.id)?.status === 'completed');
    const limits: any = await client.callTool({ name: 'get_display_constraints', arguments: {} });
    assert.equal(JSON.parse(limits.content[0].text).partial_refresh, 'unverified');
    const svg: any = await client.callTool({
      name: 'present_svg',
      arguments: {
        device_id: 'a',
        request_id: 'mcp-svg',
        refresh_profile: 'fast',
        svg: '<svg viewBox="0 0 480 720"><rect x="20" y="30" width="100" height="100" fill="blue"/></svg>',
      },
    });
    assert.equal(svg.isError, undefined);
    const svgCommand = JSON.parse(svg.content[0].text);
    await until(() => c.inbox.some((m) => m.command_id === svgCommand.id));
    assert.equal(s.store.command(svgCommand.id)?.payload.op, 'display_rle');
    assert.equal((s.store.command(svgCommand.id)?.payload as any).refresh_profile, 'fast');
    w.send(
      JSON.stringify({
        type: 'ack',
        command_id: svgCommand.id,
        status: 'completed',
        detail: 'simulated SVG',
      }),
    );
    await until(() => s.store.command(svgCommand.id)?.status === 'completed');
    const status: any = await client.callTool({
      name: 'get_command_status',
      arguments: { command_id: command.id },
    });
    assert.equal(JSON.parse(status.content[0].text).status, 'completed');
  } finally {
    await client.close();
    w?.terminate();
    await s.h.close();
    s.store.close();
  }
});

test('raster waits for advertised capability and never bypasses firmware capacity', async () => {
  const { readFile } = await import('node:fs/promises');
  const data = (await readFile(new URL('./fixtures/two-tone.nmr', import.meta.url))).toString(
    'base64',
  );
  const s = await setup();
  let w: WebSocket | undefined;
  try {
    const old = await connect(s.ws);
    w = old.w;
    const denied = s.h.enqueue('a', {
      request_id: 'old-raster',
      payload: { op: 'display_rle', data },
    });
    await until(() => s.store.command(denied.id)?.status === 'rejected');
    assert.ok(!old.inbox.some((m) => m.command_id === denied.id));
    const greeting = hello();
    const current = await connect(s.ws, {
      ...greeting,
      capabilities: {
        ...greeting.capabilities,
        formats: ['scene-v1', 'nmr1', 'nmp1'],
        max_raster_bytes: 8000,
        max_rle_bytes: 6000,
      },
    });
    w = current.w;
    const good = s.h.enqueue('a', {
      request_id: 'new-raster',
      payload: { op: 'display_rle', data },
    });
    await until(() => current.inbox.some((m) => m.command_id === good.id));
    assert.equal(current.inbox.find((m) => m.command_id === good.id).payload.data, data);
    w.send(
      JSON.stringify({
        type: 'ack',
        command_id: good.id,
        status: 'completed',
        detail: 'simulated raster',
      }),
    );
    await until(() => s.store.command(good.id)?.status === 'completed');
  } finally {
    w?.terminate();
    await s.h.close();
    s.store.close();
  }
});

test('research fence rejects power changes before anything enters the queue', async () => {
  const s = await setup(undefined, false);
  try {
    for (const payload of [
      { op: 'shutdown' },
      { op: 'sleep', seconds: 60 },
      { op: 'policy', policy: { mode: 'periodic' } },
    ]) {
      assert.throws(
        () => s.h.enqueue('a', { request_id: 'power-' + payload.op, payload }),
        /power commands inhibited/,
      );
    }
    assert.equal(s.store.db.prepare('SELECT count(*) as n FROM commands').get()?.n, 0);
    const page = s.h.enqueue('a', {
      request_id: 'safe-page',
      payload: { op: 'builtin', name: 'welcome' },
    });
    assert.equal(page.status, 'queued');
  } finally {
    await s.h.close();
    s.store.close();
  }
});

test('per-image profiles require capability and survive transport unchanged', async () => {
  const s = await setup();
  let w: WebSocket | undefined;
  try {
    const old = await connect(s.ws);
    w = old.w;
    const denied = s.h.enqueue('a', {
      request_id: 'old-profile',
      payload: { op: 'builtin', name: 'welcome', refresh_profile: 'fast' },
    });
    await until(() => s.store.command(denied.id)?.status === 'rejected');
    assert.ok(!old.inbox.some((m) => m.command_id === denied.id));
    const greeting = hello();
    const current = await connect(s.ws, {
      ...greeting,
      capabilities: { ...greeting.capabilities, refresh_profiles: ['factory', 'fast'] },
    });
    w = current.w;
    for (const refresh_profile of ['factory', 'fast']) {
      const c = s.h.enqueue('a', {
        request_id: `profile-${refresh_profile}`,
        payload: { op: 'builtin', name: 'welcome', refresh_profile },
      });
      await until(() => current.inbox.some((m) => m.command_id === c.id));
      assert.equal(
        current.inbox.find((m) => m.command_id === c.id).payload.refresh_profile,
        refresh_profile,
      );
      w.send(JSON.stringify({ type: 'ack', command_id: c.id, status: 'completed' }));
      await until(() => s.store.command(c.id)?.status === 'completed');
    }
  } finally {
    w?.terminate();
    await s.h.close();
    s.store.close();
  }
});

test('event-time telemetry is retained independently of a later periodic state', async () => {
  const s = await setup();
  let w: WebSocket | undefined;
  const context = {
    sample_age_ms: 50,
    vsys_mv: 4080,
    charging: false,
    act: false,
    power: false,
    imu_valid: true,
    imu_xyz: [12, -48, 16000],
    mic_enabled: false,
  };
  try {
    const c = await connect(s.ws);
    w = c.w;
    w.send(JSON.stringify({ type: 'event', name: 'act.click', seq: 1, at_ms: 4000, context }));
    await until(() => s.h.state('a').recent_events.length === 1);
    assert.deepEqual(s.h.state('a').recent_events[0].context, context);
  } finally {
    w?.terminate();
    await s.h.close();
    s.store.close();
  }
});
test('negotiated fragmented commands arrive as one complete UTF8 message', async () => {
  const s = await setup();
  let w: WebSocket | undefined;
  try {
    const c = await connect(s.ws, {
      ...hello(),
      capabilities: { ...hello().capabilities, fragmented_commands: true },
    });
    w = c.w;
    const scene = {
      format: 'scene-v1',
      background: 1,
      commands: Array.from({ length: 40 }, (_, i) => ({
        op: 'text',
        x: 20,
        y: i * 16,
        color: 0,
        text: '中文 Native font ' + i,
        scale: 2,
        font_size: 20,
      })),
    };
    const command = s.h.enqueue('a', {
      request_id: 'fragment-utf8',
      payload: { op: 'display', scene },
    });
    const wire = await until(() => c.inbox.find((m) => m.command_id === command.id));
    assert.ok(Buffer.byteLength(JSON.stringify(wire)) > 1536);
    assert.deepEqual(wire.payload.scene.commands, scene.commands);
    w.send(JSON.stringify({ type: 'ack', command_id: command.id, status: 'completed' }));
    await until(() => s.store.command(command.id)?.status === 'completed');
  } finally {
    w?.terminate();
    await s.h.close();
  }
});

test('empty device token accepts header-free connection and streaming capabilities', async () => {
  const s = await setup(undefined, false, '');
  const w = new WebSocket(s.ws);
  const inbox: any[] = [];
  try {
    w.on('message', b => inbox.push(JSON.parse(b.toString())));
    await once(w, 'open');
    const greeting = hello();
    w.send(JSON.stringify({...greeting, capabilities: {...greeting.capabilities, streaming_images: true, max_stream_bytes: 180000}}));
    await until(() => inbox.some(m => m.type === 'welcome'));
    assert.equal(s.h.state('a').online, true);
    assert.equal((await fetch(s.url + '/api/devices')).status, 401);
  } finally { w.terminate(); await s.h.close(); s.store.close(); }
});
