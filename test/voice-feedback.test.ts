import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { voiceFeedbackRaster } from '../src/voice-feedback.js';
import { validRaster } from '../src/raster.js';
import { Hub } from '../src/hub.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('voice processing feedback uses six-color encoding and cannot be superseded by a result queued immediately after it', async () => {
  const data = await voiceFeedbackRaster('processing');
  const b = Buffer.from(data, 'base64');
  assert.ok(validRaster(data));
  assert.equal(b[12], 4);
  const store = new Store(':memory:');
  try {
    const notice = store.enqueue('board', {
      request_id: 'notice',
      payload: {
        op: 'display_rle',
        data,
        refresh_profile: 'fast',
        force: true,
        voice_feedback: true,
      },
    });
    const result = store.enqueue('board', {
      request_id: 'final',
      payload: { op: 'display', scene: { format: 'scene-v1', background: 1, commands: [] } },
    });
    assert.equal(store.command(notice.id)!.status, 'queued');
    assert.equal(store.next('board')!.id, notice.id);
    store.markSent(notice.id);
    assert.equal(store.next('board'), undefined);
    store.ack('board', notice.id, 'completed');
    assert.equal(store.next('board')!.id, result.id);
  } finally {
    store.close();
  }
});
test('release queues one fast feedback before Harness result; incomplete audio never queues a wait page', async () => {
  const store = new Store(':memory:');
  const hub = new Hub({
    store,
    adminToken: '',
    allowPowerCommands: false,
    devices: [{ id: 'board', token: '', adapter: new MockAdapter() }],
    asr: {
      async transcribe() {
        return 'hello';
      },
    },
  });
  const address = (await hub.listen(0, '127.0.0.1')) as any;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/device?id=board`);
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  async function until(check: () => boolean) {
    for (let i = 0; i < 300; i++) {
      if (check()) return;
      await delay(10);
    }
    throw Error('feedback timeout');
  }
  const send = (m: any) => ws.send(JSON.stringify(m));
  try {
    await once(ws, 'open');
    send({
      type: 'hello',
      protocol: 2,
      device_id: 'board',
      boot_id: 'boot',
      capabilities: {
        audio: true,
        voice_feedback: true,
        display: true,
        sleep: false,
        max_scene_bytes: 8192,
        max_raster_bytes: 8000,
        formats: ['nmp1'],
        refresh_profiles: ['fast', 'factory'],
      },
    });
    await until(() => messages.some((m) => m.type === 'welcome'));
    send({
      type: 'audio.start',
      stream_id: 'bad',
      sample_rate: 16000,
      channels: 1,
      sample_bits: 16,
    });
    await until(() => messages.some((m) => m.type === 'audio.ready'));
    send({ type: 'audio.end', stream_id: 'bad', chunks: 0, complete: false });
    await until(() => messages.some((m) => m.type === 'audio.error'));
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM commands').get() as any).n, 0);
    send({
      type: 'audio.start',
      stream_id: 'good',
      sample_rate: 16000,
      channels: 1,
      sample_bits: 16,
    });
    await until(() => messages.some((m) => m.type === 'audio.ready' && m.stream_id === 'good'));
    const packet = Buffer.alloc(645);
    packet[0] = 0x41;
    ws.send(packet);
    send({ type: 'audio.end', stream_id: 'good', chunks: 1, complete: true });
    await until(() => messages.some((m) => m.type === 'command'));
    const notice = messages.find((m) => m.type === 'command');
    assert.equal(notice.payload.voice_feedback, true);
    assert.equal(notice.payload.refresh_profile, 'fast');
    send({ type: 'ack', command_id: notice.command_id, status: 'completed' });
    await until(() => messages.some((m) => m.type === 'agent.result'));
    assert.equal(hub.state('board').last_voice.stage, 'submitted');
  } finally {
    ws.terminate();
    await hub.close();
    store.close();
  }
});
