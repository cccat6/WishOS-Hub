import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Hub, type DeviceConfig } from '../src/hub.js';
import { Store } from '../src/store.js';
import type { HarnessAdapter } from '../src/adapters/types.js';
async function until(work: () => unknown) {
  for (let i = 0; i < 200; i++) {
    if (work()) return;
    await delay(10);
  }
  throw Error('timeout');
}
class SessionFixture implements HarnessAdapter {
  name = 'fixture';
  capabilities = { interrupt: false, approval: false };
  sent: { session: string; text: string }[] = [];
  async open(id?: string) {
    return id ?? 'created-session';
  }
  async send(session: string, text: string) {
    this.sent.push({ session, text });
    return 'fixture done';
  }
  async close() {}
}
test('fixed session and temporary target are independent; deduplication includes explicit target', async () => {
  const store = new Store(':memory:');
  const adapter = new SessionFixture();
  const hub = new Hub({
    store,
    adminToken: '',
    devices: [{ id: 'board', token: '', sessionId: 'fixed-session', adapter }],
  });
  await hub.listen(0, '127.0.0.1');
  try {
    const one = hub.startRun('board', { request_id: 'one', text: 'first' });
    await until(() => store.run(one.id).status === 'completed');
    const two = hub.startRun('board', {
      request_id: 'two',
      text: 'temporary',
      session_id: 'other-session',
    });
    await until(() => store.run(two.id).status === 'completed');
    assert.equal(hub.state('board').session_id, 'fixed-session');
    assert.equal(
      hub.startRun('board', { request_id: 'two', text: 'temporary', session_id: 'other-session' })
        .id,
      two.id,
    );
    assert.throws(
      () =>
        hub.startRun('board', {
          request_id: 'two',
          text: 'temporary',
          session_id: 'wrong-session',
        }),
      /request_id reused/,
    );
    const three = hub.startRun('board', { request_id: 'three', text: 'next page' });
    await until(() => store.run(three.id).status === 'completed');
    assert.deepEqual(
      adapter.sent.map((x) => x.session),
      ['fixed-session', 'other-session', 'fixed-session'],
    );
  } finally {
    await hub.close();
    store.close();
  }
});
test('recording owns the session selected at press time, including delayed ASR', async () => {
  const store = new Store(':memory:');
  const adapter = new SessionFixture();
  let finish!: (text: string) => void;
  const transcription = new Promise<string>((resolve) => (finish = resolve));
  const device: DeviceConfig = { id: 'board', token: '', sessionId: 'recording-session', adapter };
  const hub = new Hub({
    store,
    adminToken: '',
    devices: [device],
    asr: { transcribe: async () => transcription },
  });
  const address = (await hub.listen(0, '127.0.0.1')) as any;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/device?id=board`);
  let ready = false;
  try {
    ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).type === 'audio.ready') ready = true;
    });
    await once(ws, 'open');
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol: 2,
        device_id: 'board',
        boot_id: 'voice-fixture',
        capabilities: { display: true, audio: true, sleep: false, max_scene_bytes: 8192 },
      }),
    );
    await until(() => hub.state('board').online);
    ws.send(
      JSON.stringify({
        type: 'audio.start',
        stream_id: 'voice-clip',
        sample_rate: 16000,
        channels: 1,
        sample_bits: 16,
      }),
    );
    await until(() => ready);
    const frame = Buffer.alloc(7);
    frame[0] = 0x41;
    frame.writeInt16LE(100, 5);
    ws.send(frame);
    ws.send(
      JSON.stringify({ type: 'audio.end', stream_id: 'voice-clip', chunks: 1, complete: true }),
    );
    await until(() => hub.state('board').pending_voice === 1);
    device.sessionId = 'new-default';
    finish('next page');
    await until(() => adapter.sent.length === 1);
    assert.equal(adapter.sent[0]!.session, 'recording-session');
    assert.match(adapter.sent[0]!.text, /next page/);
    assert.equal(hub.state('board').session_id, 'new-default');
  } finally {
    finish('next page');
    ws.terminate();
    await hub.close();
    store.close();
  }
});
