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
