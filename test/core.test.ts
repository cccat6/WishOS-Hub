import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Scene, CommandPayload, DeviceMessage, Policy } from '../src/protocol.js';
import { AudioStream } from '../src/voice.js';
const page = (request_id: string) => ({ request_id, payload: { op: 'builtin', name: 'welcome' } });
test('queue idempotency, coalescing, ordered receipts and disconnect uncertainty', () => {
  const s = new Store(':memory:');
  try {
    const a = s.enqueue('a', page('one'));
    assert.equal(s.enqueue('a', page('one')).id, a.id);
    assert.throws(() =>
      s.enqueue('a', { request_id: 'one', payload: { op: 'sleep', seconds: 60 } }),
    );
    const b = s.enqueue('a', page('two'));
    assert.equal(s.command(a.id)?.status, 'superseded');
    assert.equal(s.next('a')?.id, b.id);
    assert.equal(s.ack('a', b.id, 'completed'), false);
    s.markSent(b.id);
    assert.equal(s.ack('other', b.id, 'completed'), false);
    assert.equal(s.ack('a', b.id, 'running'), true);
    assert.equal(s.ack('a', b.id, 'accepted'), false);
    const c = s.enqueue('a', page('three'));
    assert.equal(s.next('a'), undefined);
    s.disconnected('a');
    assert.equal(s.command(b.id)?.status, 'uncertain');
    assert.equal(s.ack('a', b.id, 'completed'), false);
    assert.equal(s.next('a')?.id, c.id);
  } finally {
    s.close();
  }
});
test('expiry and restart never replay a dispatched sleep', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-'));
  try {
    let s = new Store(join(dir, 'db'));
    const a = s.enqueue(
      'a',
      { request_id: 'sleep', ttl_s: 5, payload: { op: 'sleep', seconds: 60 } },
      1000,
    );
    s.markSent(a.id);
    s.expire(6001);
    assert.equal(s.command(a.id)?.status, 'uncertain');
    const b = s.enqueue('a', page('queued'));
    const c = s.enqueue('b', page('sent'));
    s.markSent(c.id);
    const run = s.createRun('a', 'run', 'text').run;
    s.close();
    s = new Store(join(dir, 'db'));
    assert.equal(s.command(c.id)?.status, 'uncertain');
    assert.equal(s.command(b.id)?.status, 'queued');
    assert.equal(s.run(run.id).status, 'uncertain');
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('scene constraints match finite device resources', () => {
  assert.equal(
    Scene.safeParse({
      format: 'scene-v1',
      background: 1,
      commands: [{ op: 'text', x: 10, y: 10, color: 0, scale: 2, text: 'Hi' }],
    }).success,
    true,
  );
  assert.equal(Scene.safeParse({ format: 'scene-v1', background: 4, commands: [] }).success, false);
  assert.equal(
    Scene.safeParse({
      format: 'scene-v1',
      background: 1,
      commands: Array(49).fill({ op: 'fill', x: 0, y: 0, w: 1, h: 1, color: 0 }),
    }).success,
    false,
  );
  assert.equal(
    Scene.safeParse({
      format: 'scene-v1',
      background: 1,
      commands: [{ op: 'text', x: 0, y: 0, color: 0, scale: 1, text: '汉'.repeat(33) }],
    }).success,
    false,
  );
});
export function frame(seq = 0) {
  const f = Buffer.alloc(645);
  f[0] = 0x41;
  f.writeUInt32LE(seq, 1);
  return f;
}
test('audio sequence, duration, completion and WAV framing', () => {
  const a = new AudioStream('a');
  a.append(frame());
  assert.throws(() => a.append(frame(2)));
  assert.throws(() => a.finish(1, false));
  assert.throws(() => a.finish(2, true));
  const wav = a.finish(1, true);
  assert.equal(wav.length, 684);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 640);
  a.bytes = 16000 * 2 * 300;
  assert.throws(() => a.append(frame(1)));
  assert.throws(() => new AudioStream('a').finish(0, true));
});

test('display experiments are bounded; poweroff is never replayed after link loss', () => {
  const scene = { format: 'scene-v1', background: 1, commands: [] };
  assert.equal(
    CommandPayload.safeParse({ op: 'display', scene, experiment: { spi_hz: 4000000 } }).success,
    true,
  );
  assert.equal(
    CommandPayload.safeParse({ op: 'display', scene, experiment: { spi_hz: 80000000 } }).success,
    false,
  );
  assert.equal(
    CommandPayload.safeParse({ op: 'display', scene, experiment: { register: 255 } }).success,
    false,
  );
  const s = new Store(':memory:');
  try {
    const c = s.enqueue('a', { request_id: 'off', payload: { op: 'shutdown' } });
    s.markSent(c.id);
    s.ack('a', c.id, 'running');
    s.disconnected('a');
    assert.equal(s.command(c.id)?.status, 'uncertain');
    assert.equal(s.next('a'), undefined);
  } finally {
    s.close();
  }
});

test('per-image profile is optional, bounded and part of command identity', () => {
  const scene = { format: 'scene-v1', background: 1, commands: [] };
  for (const refresh_profile of ['factory', 'fast']) {
    assert.ok(CommandPayload.safeParse({ op: 'display', scene, refresh_profile }).success);
    assert.ok(
      CommandPayload.safeParse({ op: 'builtin', name: 'welcome', refresh_profile }).success,
    );
  }
  for (const refresh_profile of ['turbo', 7, null]) {
    assert.equal(
      CommandPayload.safeParse({ op: 'display', scene, refresh_profile }).success,
      false,
    );
  }
  assert.ok(CommandPayload.safeParse({ op: 'display', scene }).success);
  const s = new Store(':memory:');
  try {
    const request = {
      request_id: 'profile',
      payload: { op: 'display', scene, refresh_profile: 'fast' },
    };
    const first = s.enqueue('a', request);
    assert.equal(s.enqueue('a', request).id, first.id);
    assert.throws(() =>
      s.enqueue('a', { ...request, payload: { ...request.payload, refresh_profile: 'factory' } }),
    );
  } finally {
    s.close();
  }
});

test('shutdown overtakes a waiting display but never another shutdown', () => {
  const s = new Store(':memory:');
  try {
    const page = s.enqueue('a', {
      request_id: 'page',
      payload: { op: 'builtin', name: 'welcome' },
    });
    s.markSent(page.id);
    s.ack('a', page.id, 'accepted');
    const off = s.enqueue('a', { request_id: 'off', payload: { op: 'shutdown' } });
    assert.equal(s.next('a')?.id, off.id);
    s.markSent(off.id);
    s.ack('a', off.id, 'running');
    s.enqueue('a', { request_id: 'off-again', payload: { op: 'shutdown' } });
    assert.equal(s.next('a'), undefined);
    s.disconnected('a');
    assert.equal(s.command(off.id)?.status, 'uncertain');
  } finally {
    s.close();
  }
});

test('persistent status pages have explicit orientations and transient pages reject', () => {
  for (const name of ['ready', 'unconfigured', 'unavailable', 'failed'])
    for (const orientation of ['portrait', 'landscape'])
      assert.equal(CommandPayload.safeParse({ op: 'builtin', name, orientation }).success, true);
  for (const name of [
    'charging',
    'low_battery',
    'loading',
    'connecting',
    'connected',
    'offline',
    'sleeping',
    'low_power',
  ])
    assert.equal(CommandPayload.safeParse({ op: 'builtin', name }).success, false);
});

test('device hello accepts the deployed persistent-page and orientation capabilities', () => {
  const hello = {
    type: 'hello',
    protocol: 2,
    device_id: 'A86AFBFEFFA28DCC',
    boot_id: 'new-boot',
    capabilities: {
      display: true,
      audio: true,
      sleep: false,
      max_scene_bytes: 8192,
      max_rle_bytes: 6000,
      max_raster_bytes: 8000,
      formats: ['scene-v1', 'nmr1', 'nmp1'],
      fragmented_commands: true,
      refresh_profiles: ['factory', 'fast'],
      builtin_layouts: ['portrait', 'landscape'],
      builtin_pages: ['ready', 'unconfigured', 'unavailable', 'failed'],
    },
  };
  assert.equal(DeviceMessage.safeParse(hello).success, true);
});

test('runtime policies carry sleep window and microphone control independently of connection roles', () => {
  assert.deepEqual(Policy.parse({ window_s: 60, audio: true }), { window_s: 60, audio: true });
  assert.deepEqual(Policy.parse({ mode: 'periodic', interval_s: 900, window_s: 60 }), {
    mode: 'periodic',
    interval_s: 900,
    window_s: 60,
  });
  for (const input of [
    { window_s: 29 },
    { window_s: 601 },
    { audio: 1 },
    { connection_mode: 'passive' },
  ])
    assert.equal(Policy.safeParse(input).success, false);
});

test('bounded vector status icons are accepted without inline images', () => {
  const icon = { op: 'icon', name: 'circle-check', x: 384, y: 126, w: 56, h: 56, color: 6 };
  assert.equal(
    Scene.parse({ format: 'scene-v1', background: 1, commands: [icon] }).commands.length,
    1,
  );
  for (const change of [{ name: 'arbitrary' }, { x: 450 }, { w: 97 }])
    assert.equal(
      Scene.safeParse({ format: 'scene-v1', background: 1, commands: [{ ...icon, ...change }] })
        .success,
      false,
    );
});
