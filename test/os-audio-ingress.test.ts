import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { OsAudioIngress } from '../src/os-audio-ingress.js';
import { speechWavRate } from '../src/voice-resample.js';
const chunk = (sequence: number) => {
  const packet = Buffer.alloc(91);
  packet[0] = 0x42;
  packet.writeUInt32LE(sequence, 1);
  packet.writeUInt16LE(160, 9);
  return {
    sequence,
    samples: 160,
    sample_start: String(sequence * 160),
    adpcm_b64: packet.toString('base64'),
  };
};
const until = async (check: () => boolean) => {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error('condition timeout');
};
test('durable compressed ingress deduplicates batches and orders ASR independently of capture/upload', async () => {
  const db = new DatabaseSync(':memory:');
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const service = new OsAudioIngress(db, async (_device, id, wav, config) => {
    calls.push(id);
    assert.equal(wav.readUInt32LE(24), 48000);
    if (id === 'one') await gate;
    else assert.equal(config.resolved_session_id, 'session-1');
    return { run_id: 'run-' + id, session_id: 'session-1' };
  });
  try {
    service.begin('device', 'one', { sample_rate: 48000, binding_group: 'chain' });
    service.begin('device', 'two', { sample_rate: 48000, binding_group: 'chain' });
    service.append('device', 'two', [chunk(0)]);
    assert.equal(
      service.finish('device', 'two', { produced_samples: '160', capture_failed: false }).durable,
      true,
    );
    assert.deepEqual(calls, []);
    service.append('device', 'one', [chunk(0), chunk(1)]);
    service.append('device', 'one', [chunk(0), chunk(1)]);
    assert.equal(service.status('device', 'one').blocks, 2);
    const conflicting = chunk(0);
    const bytes = Buffer.from(conflicting.adpcm_b64, 'base64');
    bytes[5] = 1;
    conflicting.adpcm_b64 = bytes.toString('base64');
    assert.throws(() => service.append('device', 'one', [chunk(2), conflicting]), /conflict/);
    assert.equal(service.status('device', 'one').blocks, 2);
    service.finish('device', 'one', { produced_samples: '320', capture_failed: false });
    await until(() => calls.length === 1);
    assert.equal(service.status('device', 'two').state, 'queued');
    release();
    await until(() => service.status('device', 'two').state === 'accepted');
    assert.deepEqual(calls, ['one', 'two']);
    service.finish('device', 'one', { produced_samples: '320', capture_failed: false });
    assert.equal(calls.length, 2);
    assert.equal(service.status('device', 'one').bytes, 0);
  } finally {
    release();
    await service.close();
    db.close();
  }
});
test('loss thresholds are explicit per recording; bad input cannot partially append', async () => {
  const db = new DatabaseSync(':memory:');
  let calls = 0;
  const service = new OsAudioIngress(db, async () => {
    calls++;
    return {};
  });
  try {
    service.begin('d', 'good', { sample_rate: 16000 });
    const blocks = Array.from({ length: 100 }, (_, n) => chunk(n)).filter((x) => x.sequence !== 5);
    for (let n = 0; n < blocks.length; n += 20)
      service.append('d', 'good', blocks.slice(n, n + 20));
    service.finish('d', 'good', { produced_samples: '16000', capture_failed: false });
    await until(() => service.status('d', 'good').state === 'accepted');
    assert.equal(calls, 1);
    service.begin('d', 'bad', { sample_rate: 16000, max_loss_ratio: 0 });
    service.append('d', 'bad', [chunk(1)]);
    service.finish('d', 'bad', { produced_samples: '320', capture_failed: false });
    await until(() => service.status('d', 'bad').state === 'failed');
    assert.equal(calls, 1);
    assert.equal(service.status('d', 'bad').result.error, 'audio_loss_exceeded');
    service.begin('d', 'atomic', { sample_rate: 16000 });
    assert.throws(() =>
      service.append('d', 'atomic', [chunk(0), { ...chunk(1), adpcm_b64: 'broken' }]),
    );
    assert.equal(service.status('d', 'atomic').blocks, 0);
  } finally {
    await service.close();
    db.close();
  }
});
test('speech adapter resampling preserves a voice-band tone and yields to other tasks', async () => {
  const rate = 48000,
    n = 48000,
    wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(36 + n * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    wav.writeInt16LE(Math.round(10000 * Math.sin((i * 2 * Math.PI * 1000) / rate)), 44 + i * 2);
  let yielded = false;
  setImmediate(() => (yielded = true));
  const out = await speechWavRate(wav, 16000);
  assert.ok(yielded);
  assert.equal(out.length, 32044);
  assert.equal(out.readUInt32LE(24), 16000);
  let error = 0,
    energy = 0;
  for (let i = 100; i < 15900; i++) {
    const expected = 10000 * Math.sin((i * 2 * Math.PI * 1000) / 16000),
      value = out.readInt16LE(44 + i * 2);
    error += (value - expected) ** 2;
    energy += expected ** 2;
  }
  assert.ok(error / energy < 0.001);
});
test('a terminal collector failure immediately unblocks the next upload without cancelling admitted work', async () => {
  const db = new DatabaseSync(':memory:');
  const executions: string[] = [];
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = new OsAudioIngress(db, async (_d, id) => {
    executions.push(id);
    await gate;
    return { run_id: 'run-' + id };
  });
  try {
    service.begin('d', 'expired-device-tail', { sample_rate: 16000 });
    service.append('d', 'expired-device-tail', [chunk(0)]);
    service.begin('d', 'next', { sample_rate: 16000 });
    service.append('d', 'next', [chunk(0)]);
    service.finish('d', 'next', { produced_samples: '160', capture_failed: false });
    assert.deepEqual(executions, []);
    const aborted = service.abortUpload('d', 'expired-device-tail', 'recording_not_found');
    assert.equal(aborted.state, 'failed');
    assert.equal(aborted.bytes, 0);
    await until(() => executions.length === 1);
    assert.deepEqual(executions, ['next']);
    assert.equal(service.abortUpload('d', 'next', 'late-collector-error').state, 'processing');
    finish();
    await until(() => service.status('d', 'next').state === 'accepted');
    assert.equal(service.status('d', 'next').result.run_id, 'run-next');
  } finally {
    finish();
    await service.close();
    db.close();
  }
});

test('managed recording retries compare structured context by value and reject changed targets without discarding buffered audio', async () => {
  const db = new DatabaseSync(':memory:'),
    service = new OsAudioIngress(db, async () => ({}));
  try {
    const config = {
      sample_rate: 16000,
      managed_request: true,
      managed_request_id: 'request',
      request_scope: 'app-instance',
      request_context: {
        system: { current: { instance_id: 4, application_id: 'voice' } },
        application: { intent: 'edit' },
      },
    };
    service.begin('device', 'context', config);
    service.append('device', 'context', [chunk(0)]);
    service.begin('device', 'context', {
      ...config,
      request_context: {
        application: { intent: 'edit' },
        system: { current: { application_id: 'voice', instance_id: 4 } },
      },
    });
    assert.equal(service.status('device', 'context').blocks, 1);
    assert.throws(
      () => service.begin('device', 'context', { ...config, request_scope: 'other-instance' }),
      /configuration|conflict/,
    );
    assert.equal(service.status('device', 'context').blocks, 1);
  } finally {
    await service.close();
    db.close();
  }
});
