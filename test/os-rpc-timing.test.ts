import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { OsRpcSocket } from '../src/os-rpc-socket.js';
class Wire extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Buffer[] = [];
  send(frame: Buffer) {
    this.sent.push(frame);
  }
  close() {
    this.readyState = WebSocket.CLOSED as any;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
}
function frames(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)),
    result: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += 1012) {
    const frame = Buffer.alloc(12 + Math.min(1012, bytes.length - at));
    frame.write('WOS1');
    frame.writeUInt32LE(1, 4);
    frame.writeUInt16LE(at, 8);
    frame.writeUInt16LE(bytes.length, 10);
    bytes.copy(frame, 12, at, at + frame.length - 12);
    result.push(frame);
  }
  return result;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
test('RPC diagnostics separate queue delay, first WOS fragment and response assembly without retaining payloads', async () => {
  const wire = new Wire(),
    peer = new OsRpcSocket(wire as any);
  try {
    for (const f of frames({ type: 'hello', abi: 'wishos-rpc/1', boot_id: 'b' }))
      wire.emit('message', f, true);
    const one = peer.rpc('/fs', 'read', { file: 'private-file-value' });
    const two = peer.rpc('/sys/clock', 'read', {});
    assert.equal(wire.sent.length, 1);
    assert.equal(peer.diagnostics().pending, 2);
    await wait(10);
    const response = {
      id: 1,
      boot_id: 'b',
      ok: true,
      result: { text: 'private-result-value' + 'x'.repeat(1200) },
    };
    const fragments = frames(response);
    wire.emit('message', fragments[0], true);
    await wait(10);
    for (const f of fragments.slice(1)) wire.emit('message', f, true);
    await one;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(wire.sent.length, 2);
    for (const f of frames({ id: 2, boot_id: 'b', ok: true, result: {} }))
      wire.emit('message', f, true);
    await two;
    const d = peer.diagnostics();
    assert.equal(d.pending, 0);
    assert.equal(d.recent.length, 2);
    const [first, second] = d.recent;
    assert.equal(first.path, '/fs');
    assert.equal(first.method, 'read');
    assert(first.response_span_ms >= 5);
    assert(second.queue_ms >= 10);
    assert(first.round_trip_ms >= first.first_frame_ms);
    assert.equal(first.response_bytes, Buffer.byteLength(JSON.stringify(response)));
    assert(!JSON.stringify(d).includes('private-file-value'));
    assert(!JSON.stringify(d).includes('private-result-value'));
  } finally {
    peer.close();
  }
});

const turn = () => new Promise<void>((r) => setImmediate(r));
function hello(wire: Wire) {
  for (const f of frames({ type: 'hello', abi: 'wishos-rpc/1', boot_id: 'b' }))
    wire.emit('message', f, true);
}
function reply(wire: Wire, id: number) {
  for (const f of frames({ id, boot_id: 'b', ok: true, result: {} })) wire.emit('message', f, true);
}
function sent(wire: Wire) {
  return wire.sent
    .filter((f) => f.readUInt16LE(8) === 0)
    .map((f) => JSON.parse(f.subarray(12).toString()));
}

test('background discovery yields the wire slot to pending resource work without encoding host hints', async () => {
  const wire = new Wire(),
    peer = new OsRpcSocket(wire as any);
  hello(wire);
  try {
    const discovery = peer.rpc(
      '/services/remote',
      'peek',
      { after_id: 0 },
      { priority: 'background' },
    );
    assert.equal(wire.sent.length, 0);
    const active = peer.rpc('/dev/mic', 'read_chunk', { limit: 16 });
    assert.deepEqual(
      sent(wire).map((x) => x.id),
      [2],
    );
    assert.deepEqual(Object.keys(sent(wire)[0]).sort(), ['args', 'id', 'method', 'path']);
    reply(wire, 2);
    await active;
    await turn();
    assert.deepEqual(
      sent(wire).map((x) => x.id),
      [2, 1],
    );
    reply(wire, 1);
    await discovery;
    assert.deepEqual(
      peer.diagnostics().recent.map((x) => x.priority),
      ['foreground', 'background'],
    );
  } finally {
    peer.close();
  }
});

test('consumer continuations enqueue the next batch before an older background scan, with one in-flight command', async () => {
  const wire = new Wire(),
    peer = new OsRpcSocket(wire as any);
  hello(wire);
  try {
    const first = peer.rpc('/dev/mic', 'read_chunk', {});
    const discovery = peer.rpc('/services/remote', 'read', {}, { priority: 'background' });
    const continuation = (async () => {
      await first;
      await Promise.resolve();
      await Promise.resolve();
      return peer.rpc('/dev/mic', 'read_chunk', { after_sequence: 16 });
    })();
    reply(wire, 1);
    await turn();
    assert.deepEqual(
      sent(wire).map((x) => x.id),
      [1, 3],
    );
    reply(wire, 3);
    await continuation;
    await turn();
    assert.deepEqual(
      sent(wire).map((x) => x.id),
      [1, 3, 2],
    );
    reply(wire, 2);
    await discovery;
  } finally {
    peer.close();
  }
});

test('bounded foreground bursts retain background progress and FIFO within each class', async () => {
  for (const maximum of [1, 2, 4]) {
    const wire = new Wire(),
      peer = new OsRpcSocket(wire as any, { maxForegroundBurst: maximum });
    hello(wire);
    try {
      const background = peer.rpc('/services/remote', 'read', {}, { priority: 'background' });
      const normal = Array.from({ length: 5 }, (_, i) => peer.rpc('/fs', 'read', { offset: i }));
      for (let n = 0; n < 6; n++) {
        const commands = sent(wire);
        assert.equal(commands.length, n + 1);
        reply(wire, commands[n].id);
        await turn();
      }
      await Promise.all([background, ...normal]);
      const order = sent(wire).map((x) => x.id);
      assert.equal(order.indexOf(1), maximum);
      assert.deepEqual(
        order.filter((x) => x !== 1),
        [2, 3, 4, 5, 6],
      );
    } finally {
      peer.close();
    }
  }
});

test('an already dispatched scan is never preempted and shutdown rejects queued work without transmitting it', async () => {
  const wire = new Wire(),
    peer = new OsRpcSocket(wire as any);
  hello(wire);
  const scan = peer.rpc('/services/remote', 'read', {}, { priority: 'background' });
  const scanError = assert.rejects(
    scan,
    (e: any) => e.dispatched === true && e.message === 'rpc_outcome_unknown',
  );
  await turn();
  assert.deepEqual(
    sent(wire).map((x) => x.id),
    [1],
  );
  const foreground = peer.rpc('/dev/mic', 'read_chunk', {});
  const foregroundError = assert.rejects(
    foreground,
    (e: any) => e.dispatched === false && e.message === 'device_disconnected_before_dispatch',
  );
  assert.equal(wire.sent.length, 1);
  peer.close();
  await Promise.all([scanError, foregroundError]);
  await turn();
  assert.equal(wire.sent.length, 1);
});
