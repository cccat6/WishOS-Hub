import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';
import { MockAdapter } from './helpers/mock-adapter.js';
const pause = () => new Promise<void>((r) => setTimeout(r, 10));
const until = async (check: () => boolean) => {
  for (let i = 0; i < 600; i++) {
    if (check()) return;
    await pause();
  }
  throw Error('condition timeout');
};
function frame(value: unknown, id = 1) {
  const b = Buffer.from(JSON.stringify(value)),
    out: Buffer[] = [];
  for (let at = 0; at < b.length; at += 1012) {
    const p = Buffer.alloc(12 + Math.min(1012, b.length - at));
    p.write('WOS1');
    p.writeUInt32LE(id, 4);
    p.writeUInt16LE(at, 8);
    p.writeUInt16LE(b.length, 10);
    b.copy(p, 12, at, at + p.length - 12);
    out.push(p);
  }
  return out;
}
function packet(n: number) {
  const b = Buffer.alloc(91);
  b[0] = 0x42;
  b.writeUInt32LE(n, 1);
  b.writeUInt16LE(160, 9);
  return {
    sequence: n,
    samples: 160,
    sample_start: String(n * 160),
    adpcm_b64: b.toString('base64'),
  };
}
test('HTTP RPC: consecutive compressed recordings reach one Harness session as an ordered steer; MCP uses resource ABI', async () => {
  const pending = [1, 2].map((id) => ({
    id,
    request_id: 'boot:' + id,
    route: 'voice',
    payload: { recording_id: 'r' + id },
    state: 'queued',
  }));
  const ack = new Map<string, number>(),
    released: string[] = [],
    completions: any[] = [],
    calls: any[] = [];
  let asrs = 0,
    send = 0,
    steers = 0,
    finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  const adapter: any = {
    name: 'fixture',
    capabilities: { steer: true, interrupt: false, approval: false },
    open: async () => 'session',
    async send() {
      send++;
      await gate;
      return 'done';
    },
    steer: async (session: string, text: string) => {
      assert.equal(session, 'session');
      assert.equal(text, 'voice 2');
      steers++;
      return true;
    },
    close: async () => {
      finish();
    },
  };
  const device = createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    const a = JSON.parse(Buffer.concat(parts).toString());
    calls.push(a);
    let result: any = {},
      ok = true;
    if (a.path === '/services/remote') {
      if (a.method === 'peek')
        result = pending.find((x) => x.id > (a.args.after_id ?? 0)) ?? { state: 'empty' };
      else if (a.method === 'complete') {
        completions.push(a.args);
        const at = pending.findIndex((x) => x.id === a.args.id);
        if (at >= 0) pending.splice(at, 1);
      }
    } else if (a.path === '/dev/mic') {
      const id = a.args.recording_id;
      if (a.method === 'read_chunk' && a.args.after_sequence !== undefined)
        ack.set(id, a.args.after_sequence);
      if (a.method === 'read' || a.method === 'read_chunk') {
        result = {
          recording_id: id,
          sample_rate: 16000,
          recording: false,
          produced_samples: '320',
          capture_failed: false,
          storage_pending: false,
          storage_requested: 'off',
          chunks: a.method === 'read_chunk' && !ack.get(id) ? [packet(0), packet(1)] : [],
          offered_sequence: 2,
        };
      } else if (a.method === 'ack') ack.set(id, a.args.next_sequence);
      else if (a.method === 'release') released.push(id);
    } else if (a.path === '/sys/capabilities')
      result = { devices: [{ path: '/different/display', methods: 'read,render' }], more: false };
    else if (a.path === '/different/display') result = { geometry: [239, 321] };
    else ok = false;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: a.id, boot_id: 'boot', ok, result }));
  });
  device.listen(0, '127.0.0.1');
  await once(device, 'listening');
  const address = device.address() as any;
  const store = new Store(':memory:'),
    hub = new Hub({
      store,
      adminToken: '',
      devices: [
        {
          id: 'c3',
          token: '',
          adapter,
          deviceUrl: `http://127.0.0.1:${address.port}`,
        },
      ],
      asr: { transcribe: async () => `voice ${++asrs}` },
    });
  const h = (await hub.listen(0, '127.0.0.1')) as any;
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.port}/mcp`)),
    );
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'invoke_resource'));
    assert.ok(!tools.tools.some((t) => t.name === 'present_text'));
    const discovered: any = await client.callTool({
      name: 'discover_resources',
      arguments: { device_id: 'c3' },
    });
    assert.equal(
      JSON.parse(discovered.content[0].text).result.devices[0].path,
      '/different/display',
    );
    await until(() => completions.length === 2);
    assert.equal(send, 1);
    assert.equal(steers, 1);
    assert.equal(asrs, 2);
    assert.deepEqual(released, ['r1', 'r2']);
    assert.equal(
      completions.every((c) => c.ok),
      true,
    );
    assert.equal(
      calls.some((c) => c.path === '/fs' && c.method === 'write'),
      false,
    );
  } finally {
    await client.close();
    finish();
    await hub.close();
    store.close();
    await new Promise<void>((r) => device.close(() => r()));
  }
});
test('WebSocket RPC uses the same RPC envelope through fragmented WebSocket frames', async () => {
  const store = new Store(':memory:'),
    hub = new Hub({
      store,
      adminToken: '',
      devices: [{ id: 'active', token: '', adapter: new MockAdapter() }],
    });
  const h = (await hub.listen(0, '127.0.0.1')) as any,
    base = `http://127.0.0.1:${h.port}`,
    ws = new WebSocket(base.replace('http', 'ws') + '/os/device?id=active');
  let buf = Buffer.alloc(4096),
    serial = 2;
  ws.on('message', (raw) => {
    const p = Buffer.from(raw as Buffer),
      at = p.readUInt16LE(8),
      total = p.readUInt16LE(10);
    p.copy(buf, at, 12);
    if (at + p.length - 12 !== total) return;
    const request = JSON.parse(buf.toString('utf8', 0, total));
    const result =
      request.path === '/services/remote'
        ? { state: 'empty' }
        : { text: 'x'.repeat(2800), method: request.method };
    for (const part of frame({ id: request.id, ok: true, boot_id: 'ws-boot', result }, serial++))
      ws.send(part);
  });
  try {
    await once(ws, 'open');
    for (const p of frame({ type: 'hello', abi: 'wishos-rpc/1', boot_id: 'ws-boot' })) ws.send(p);
    await until(() => hub.state('active').online);
    const response = await fetch(base + '/api/os/devices/active/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/arbitrary/device',
        method: 'read',
        args: { text: 'q'.repeat(2800) },
      }),
    });
    const reply = await response.json();
    assert.equal(reply.result.text.length, 2800);
    assert.equal(reply.boot_id, 'ws-boot');
    const parallel = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        fetch(base + '/api/os/devices/active/invoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: '/arbitrary/device',
            method: 'read',
            args: { sequence: i, text: 'q'.repeat(3950) },
          }),
        }).then((r) => r.json()),
      ),
    );
    assert.equal(parallel.length, 4);
    assert.ok(parallel.every((r) => r.ok && r.result.text.length === 2800));
  } finally {
    ws.terminate();
    await hub.close();
    store.close();
  }
});

test('compact managed voice crosses fragmented WS, durable ingress, ASR and the fixed Harness before typed result handoff', async () => {
  const { WireDevice, eventually } = await import('./fixtures/wire-device.js');
  const { packBatch } = await import('./fixtures/audio-batch.js');
  const { readFile } = await import('node:fs/promises');
  const native = await readFile(new URL('./fixtures/os-voice-ima.bin', import.meta.url));
  const chunks = Array.from({ length: 64 }, (_, i) => ({
    sequence: i,
    samples: 160,
    sample_start: String(i * 160),
    adpcm_b64: native.subarray(i * 91, (i + 1) * 91).toString('base64'),
  }));
  const store = new Store(':memory:');
  let nativeAck = 0,
    asrs = 0,
    sends = 0,
    ready = false,
    completion: any;
  const adapter: any = {
    name: 'fixture',
    capabilities: { interrupt: false, approval: false },
    async open(id: string) {
      assert.equal(id, 'fixed-session');
      return id;
    },
    async send(session: string, text: string) {
      sends++;
      assert.equal(asrs, 1);
      assert.equal(session, 'fixed-session');
      assert(text.includes('"application_id":"voice"'));
      assert(text.includes('"application_id":"clock"'));
      assert(text.endsWith('请回答测试成功'));
      return JSON.stringify({
        format: 'wishos-result/2',
        actions: [
          {
            type: 'application',
            recipient: 'origin',
            topic: 'voice-result',
            wait: 'processed',
            data: { text: '测试成功' },
          },
        ],
      });
    },
    async close() {},
  };
  const hub = new Hub({
    store,
    adminToken: '',
    devices: [{ id: 'compact', token: 'fixture-pair', sessionId: 'fixed-session', adapter }],
    asr: {
      async transcribe(wav) {
        asrs++;
        assert.equal(nativeAck, chunks.length);
        assert.equal(wav.readUInt32LE(24), 16000);
        assert.equal(wav.readUInt32LE(40), chunks.length * 160 * 2);
        return '请回答测试成功';
      },
    },
  });
  const address = (await hub.listen(0, '127.0.0.1')) as any;
  const device = new WireDevice();
  device.boot = 'compact-boot';
  device.descriptions['/dev/mic'] = {
    batch_read: {
      method: 'read_batch',
      maximum_chunks: 30,
      format: 'wishos-audio-batch/1',
      acknowledgement_cursor: 'after_sequence',
    },
  };
  const request = {
    id: 1,
    request_id: 'compact-boot:1',
    route: 'wishos.ai',
    state: 'queued',
    payload: {
      format: 'wishos-ai/2',
      input: { kind: 'voice', recording_id: 'recording', session_id: 'fixed-session' },
      context: {
        current: { application_id: 'voice', instance_id: 2, catalog_revision: 1 },
        launch_origin: { application_id: 'clock', instance_id: 1, catalog_revision: 1 },
      },
    },
  };
  const answer = (call: any, result: any) => {
    for (const f of frame({ id: call.id, boot_id: device.boot, ok: true, result }, call.id + 10000))
      device.socket.send(f);
  };
  device.beforeRespond = (call) => {
    if (call.path !== '/services/remote') return;
    if (call.method === 'read')
      answer(call, {
        pending: ready && !completion,
        requests: ready && !completion ? [{ id: 1, state: 'queued' }] : [],
      });
    else if (call.method === 'peek')
      answer(call, ready && !completion && call.args.after_id < 1 ? request : { state: 'empty' });
    else if (call.method === 'complete') {
      completion = call.args;
      answer(call, {});
    } else throw Error('unexpected remote method');
    return false;
  };
  device.resourceHandler = (call) => {
    assert.equal(call.path, '/dev/mic');
    if (call.args.after_sequence !== undefined || call.method === 'ack') {
      const cursor = call.args.after_sequence ?? call.args.next_sequence;
      const durable = store.db
        .prepare('SELECT next_sequence FROM os_audio_streams WHERE device=? AND id=?')
        .get('compact', 'recording') as any;
      assert(durable && cursor <= durable.next_sequence, 'device ACK preceded Host durability');
      nativeAck = cursor;
    }
    if (call.method === 'release') return {};
    const common = {
      recording_id: 'recording',
      sample_rate: 16000,
      recording: false,
      produced_samples: String(chunks.length * 160),
      capture_failed: false,
      storage_pending: false,
      storage_requested: 'off',
      encoding: 'ima-adpcm',
      buffered_chunks: chunks.length - nativeAck,
      acknowledged_sequence: nativeAck,
      offered_sequence: chunks.length,
    };
    if (call.method === 'ack') return common;
    assert.equal(call.method, 'read_batch');
    assert.equal(call.args.limit, device.descriptions['/dev/mic'].batch_read.maximum_chunks);
    const batch = chunks.slice(nativeAck, nativeAck + Math.min(call.args.limit, 24));
    return { ...common, batch_encoding: 'wishos-audio-batch/1', batch_b64: packBatch(batch) };
  };
  try {
    await device.connect(`ws://127.0.0.1:${address.port}/os/device?id=compact`, 'fixture-pair');
    await eventually(
      async () =>
        device.calls.some((c) => c.path === '/sys/capabilities' && c.args.path === '/dev/mic') &&
        device.calls.some((c) => c.path === '/services/remote'),
    );
    ready = true;
    await eventually(async () => completion, 10000);
    await eventually(
      async () =>
        (
          store.db
            .prepare('SELECT state FROM os_remote_journal WHERE device=? AND key=?')
            .get('compact', 'compact-boot:1') as any
        )?.state === 'acknowledged',
    );
    assert.equal(completion.ok, true, JSON.stringify(completion));
    assert.equal(completion.result.format, 'wishos-result/2');
    assert.deepEqual(completion.result.actions, [
      {
        type: 'application',
        recipient: 'origin',
        topic: 'voice-result',
        wait: 'processed',
        data: { text: '测试成功' },
      },
    ]);
    assert.equal(asrs, 1);
    assert.equal(sends, 1);
    assert.equal(nativeAck, chunks.length);
    assert.equal(hub.state('compact').audio_delivery?.read_method, 'read_batch');
    assert.equal(hub.state('compact').audio_delivery?.phase, 'accepted');
    assert.equal(
      device.calls.filter((c) => c.path === '/dev/mic' && c.method === 'read_batch').length,
      3,
    );
    assert.equal(
      device.calls.filter((c) => c.path === '/sys/capabilities' && c.args.path === '/dev/mic')
        .length,
      1,
    );
    assert(!device.calls.some((c) => c.path === '/dev/mic' && c.method === 'read_chunk'));
    assert(
      !device.calls.some(
        (c) => c.path === '/fs' && ['write', 'append', 'begin'].includes(c.method),
      ),
    );
  } finally {
    await device.close();
    await hub.close();
    store.close();
  }
});
