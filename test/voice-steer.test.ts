import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';
import type { HarnessAdapter } from '../src/adapters/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await delay(10);
  }
  throw Error('voice test timeout');
}
class Controlled implements HarnessAdapter {
  name = 'controlled';
  capabilities = { interrupt: false, approval: false, steer: true };
  runs: { session: string; text: string; result: ReturnType<typeof deferred<string>> }[] = [];
  steers: { session: string; text: string }[] = [];
  openGate?: ReturnType<typeof deferred<string>>;
  steerGate?: ReturnType<typeof deferred<boolean>>;
  async open(id?: string) {
    return this.openGate ? await this.openGate.promise : (id ?? 'new-session');
  }
  send(session: string, text: string) {
    const result = deferred<string>();
    this.runs.push({ session, text, result });
    return result.promise;
  }
  async steer(session: string, text: string) {
    this.steers.push({ session, text });
    return this.steerGate ? await this.steerGate.promise : true;
  }
  async close() {
    for (const run of this.runs) run.result.resolve('closed');
    this.openGate?.resolve('new-session');
    this.steerGate?.resolve(false);
  }
}
async function setup(options: { unbound?: boolean; feedback?: boolean; noSteer?: boolean } = {}) {
  const store = new Store(':memory:'),
    adapter = new Controlled();
  if (options.noSteer) (adapter as any).steer = undefined;
  const asrs: ReturnType<typeof deferred<string>>[] = [];
  const hub = new Hub({
    store,
    adminToken: '',
    allowPowerCommands: false,
    devices: [
      { id: 'board', token: '', adapter, sessionId: options.unbound ? undefined : 'session-fixed' },
    ],
    asr: {
      transcribe() {
        const item = deferred<string>();
        asrs.push(item);
        return item.promise;
      },
    },
  });
  const address = (await hub.listen(0, '127.0.0.1')) as any;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/device?id=board`),
    messages: any[] = [];
  const imageParts: Buffer[] = [];
  ws.on('message', (raw, binary) => {
    if (binary) {
      imageParts.push(Buffer.from(raw as Buffer));
      return;
    }
    const m = JSON.parse(raw.toString());
    messages.push(m);
    if (m.type === 'command' || m.type === 'image.end')
      ws.send(JSON.stringify({ type: 'ack', command_id: m.command_id, status: 'completed' }));
  });
  await once(ws, 'open');
  const send = (m: any) => ws.send(JSON.stringify(m));
  send({
    type: 'hello',
    protocol: 2,
    device_id: 'board',
    boot_id: 'boot',
    capabilities: {
      audio: true,
      display: true,
      voice_feedback: options.feedback ?? false,
      sleep: false,
      max_scene_bytes: 8192,
      max_raster_bytes: 8000,
      streaming_images: options.streaming ?? false,
      max_stream_bytes: 180000,
      formats: ['nmp1'],
      refresh_profiles: ['fast', 'factory'],
    },
  });
  await until(() => messages.some((m) => m.type === 'welcome'));
  async function start(id: string) {
    send({ type: 'audio.start', stream_id: id, sample_rate: 16000, channels: 1, sample_bits: 16 });
    await until(() => messages.some((m) => m.type === 'audio.ready' && m.stream_id === id));
  }
  function end(id: string, complete = true) {
    const packet = Buffer.alloc(645);
    packet[0] = 0x41;
    ws.send(packet);
    send({ type: 'audio.end', stream_id: id, chunks: 1, complete });
  }
  async function voice(id: string) {
    await start(id);
    end(id);
  }
  async function close() {
    ws.terminate();
    for (const asr of asrs) asr.resolve('closed');
    await hub.close();
    store.close();
  }
  return {
    store,
    hub,
    adapter,
    asrs,
    messages,
    imageParts,
    sendBinary: (b: Buffer) => ws.send(b),
    send,
    start,
    end,
    voice,
    close,
  };
}

test('second voice steers the active turn without opening another run or repeating wait page', async () => {
  const t = await setup({ feedback: true });
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('first instruction');
    await until(() => t.adapter.runs.length === 1 && t.hub.state('board').pending_voice === 0);
    await t.voice('two');
    await until(() => t.asrs.length === 2);
    t.asrs[1].resolve('also add the battery level');
    await until(() => t.hub.state('board').last_voice.stage === 'steered');
    assert.equal(t.adapter.runs.length, 1);
    assert.deepEqual(t.adapter.steers, [
      { session: 'session-fixed', text: 'also add the battery level' },
    ]);
    assert.equal(
      (
        t.store.db
          .prepare(
            "SELECT count(*) AS n FROM commands WHERE json_extract(payload,'$.voice_feedback')=1",
          )
          .get() as any
      ).n,
      1,
    );
    assert.equal(
      (t.store.db.prepare('SELECT status FROM voice_steers').get() as any).status,
      'accepted',
    );
    assert.ok(t.hub.state('board').active_run);
    t.adapter.runs[0].result.resolve('实际结果：剩余额度 75%。');
    await until(() => t.messages.some((m) => m.type === 'command' && !m.payload.voice_feedback));
    assert.equal(
      t.messages.filter((m) => m.type === 'command' && m.payload.voice_feedback).length,
      1,
    );
    assert.equal(t.messages.filter((m) => m.type === 'agent.result').length, 1);
    assert.equal(t.hub.state('board').active_run, null);
  } finally {
    await t.close();
  }
});

test('rapid voices during ASR and initial session open keep release order in the same new session', async () => {
  const t = await setup({ unbound: true });
  t.adapter.openGate = deferred<string>();
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    await t.voice('two');
    await t.voice('three');
    await until(() => t.hub.state('board').pending_voice === 3);
    assert.equal(t.asrs.length, 1);
    t.asrs[0].resolve('first');
    await delay(30);
    assert.equal(t.adapter.runs.length, 0);
    t.adapter.openGate.resolve('new-session');
    await until(() => t.asrs.length === 2);
    t.asrs[1].resolve('second');
    await until(() => t.asrs.length === 3);
    t.asrs[2].resolve('third');
    await until(() => t.adapter.steers.length === 2);
    assert.deepEqual(t.adapter.steers, [
      { session: 'new-session', text: 'second' },
      { session: 'new-session', text: 'third' },
    ]);
    assert.equal(t.adapter.runs.length, 1);
    assert.equal(t.store.session('board', 'controlled'), 'new-session');
  } finally {
    await t.close();
  }
});

test('turn completes during follow-up ASR: continuation stays in captured session, no stale fallback page', async () => {
  const t = await setup();
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('first');
    await until(() => t.adapter.runs.length === 1 && t.hub.state('board').pending_voice === 0);
    await t.voice('two');
    await until(() => t.asrs.length === 2);
    t.store.bind('board', 'controlled', 'different-default');
    t.adapter.runs[0].result.resolve('obsolete first answer');
    await until(() => !t.hub.state('board').active_run);
    assert.equal(t.messages.filter((m) => m.type === 'command').length, 0);
    assert.ok(t.messages.find((m) => m.type === 'agent.result').agent_busy);
    t.asrs[1].resolve('second');
    await until(() => t.adapter.runs.length === 2);
    assert.equal(t.adapter.runs[1].session, 'session-fixed');
    assert.equal(t.adapter.steers.length, 0);
  } finally {
    await t.close();
  }
});

test('completion races with steer RPC: continue exactly once; uncertain RPC must never replay', async () => {
  for (const uncertain of [false, true]) {
    const t = await setup();
    t.adapter.steerGate = deferred<boolean>();
    try {
      await t.voice('one');
      await until(() => t.asrs.length === 1);
      t.asrs[0].resolve('first');
      await until(() => t.adapter.runs.length === 1 && t.hub.state('board').pending_voice === 0);
      await t.voice('two');
      await until(() => t.asrs.length === 2);
      t.asrs[1].resolve('second');
      await until(() => t.adapter.steers.length === 1);
      t.adapter.runs[0].result.resolve('first final');
      if (uncertain) t.adapter.steerGate.reject(Error('RPC timeout'));
      else t.adapter.steerGate.resolve(false);
      await until(() => t.hub.state('board').pending_voice === 0);
      assert.equal(t.adapter.runs.length, uncertain ? 1 : 2);
      if (uncertain)
        assert.equal(
          (t.store.db.prepare('SELECT status FROM voice_steers').get() as any).status,
          'uncertain',
        );
    } finally {
      await t.close();
    }
  }
});

test('invalid/failed follow-up does not clear an active run or affect a newer recording', async () => {
  const t = await setup();
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('first');
    await until(() => t.adapter.runs.length === 1 && t.hub.state('board').pending_voice === 0);
    const run = t.hub.state('board').active_run;
    await t.start('bad');
    t.end('bad', false);
    await until(() => t.messages.some((m) => m.type === 'audio.error'));
    assert.equal(t.hub.state('board').active_run, run);
    await t.voice('failed');
    await until(() => t.asrs.length === 2);
    await t.start('newer');
    t.asrs[1].reject(Error('ASR outage'));
    await until(() => t.messages.some((m) => m.type === 'audio.error' && m.stream_id === 'failed'));
    assert.equal(t.hub.state('board').active_run, run);
    t.end('newer');
    await until(() => t.asrs.length === 3);
    t.asrs[2].resolve('third valid');
    await until(() => t.adapter.steers.length === 1);
    assert.equal(t.adapter.steers[0].text, 'third valid');
  } finally {
    await t.close();
  }
});

test('Harness without steering queues a same-session continuation instead of dropping voice', async () => {
  const t = await setup({ noSteer: true });
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('first');
    await until(() => t.adapter.runs.length === 1 && t.hub.state('board').pending_voice === 0);
    await t.voice('two');
    await until(() => t.asrs.length === 2);
    t.asrs[1].resolve('second');
    await delay(30);
    assert.equal(t.adapter.runs.length, 1);
    t.adapter.runs[0].result.resolve('first');
    await until(() => t.adapter.runs.length === 2);
    assert.equal(t.adapter.runs[1].session, 'session-fixed');
  } finally {
    await t.close();
  }
});

test('MCP display is retained on completion; Hub never adds a completion page over it', async () => {
  const t = await setup();
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('show a picture');
    await until(() => t.adapter.runs.length === 1 && t.hub.state('board').pending_voice === 0);
    t.hub.enqueue('board', {
      request_id: 'real-output',
      payload: { op: 'display', scene: { format: 'scene-v1', background: 1, commands: [] } },
    });
    t.adapter.runs[0].result.resolve('Here is your picture');
    await until(() => !t.hub.state('board').active_run);
    await delay(50);
    assert.equal((t.store.db.prepare('SELECT count(*) AS n FROM commands').get() as any).n, 1);
  } finally {
    await t.close();
  }
});

test('voice PCM queue is bounded and a duplicate pending stream never becomes a second instruction', async () => {
  const t = await setup();
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.send({
      type: 'audio.start',
      stream_id: 'one',
      sample_rate: 16000,
      channels: 1,
      sample_bits: 16,
    });
    await until(() => t.messages.some((m) => m.type === 'audio.error' && m.stream_id === 'one'));
    for (const id of ['two', 'three', 'four']) await t.voice(id);
    await until(() => t.hub.state('board').pending_voice === 4);
    t.send({
      type: 'audio.start',
      stream_id: 'five',
      sample_rate: 16000,
      channels: 1,
      sample_bits: 16,
    });
    await until(() => t.messages.some((m) => m.type === 'audio.error' && m.stream_id === 'five'));
    assert.equal(t.hub.state('board').pending_voice, 4);
    for (let n = 0; n < 4; n++) {
      await until(() => t.asrs.length > n);
      t.asrs[n].resolve('instruction-' + n);
    }
    await until(() => t.hub.state('board').pending_voice === 0);
    assert.equal(t.adapter.runs.length, 1);
    assert.equal(t.adapter.steers.length, 3);
  } finally {
    await t.close();
  }
});

test('voice recorded during explicitly targeted run steers that session rather than the default', async () => {
  const t = await setup();
  try {
    t.hub.startRun('board', { request_id: 'targeted', text: 'first', session_id: 'other-session' });
    await until(() => t.adapter.runs.length === 1);
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('modify the current task');
    await until(() => t.adapter.steers.length === 1);
    assert.equal(t.adapter.steers[0].session, 'other-session');
    assert.equal(t.hub.state('board').session_id, 'session-fixed');
  } finally {
    await t.close();
  }
});

test('actual long text answer uses native six-color streaming rather than an 8 KiB completion notice', async () => {
  const t = await setup({ streaming: true });
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('show the detailed answer');
    await until(() => t.adapter.runs.length === 1 && t.hub.state('board').pending_voice === 0);
    t.adapter.runs[0].result.resolve(
      '你的 Codex 本周剩余额度为 75%。\n\n已按你的第二条语音补充电池状态。当前无法测量电池百分比，所以保留为未知。\n\n这页展示的是任务实际回复。',
    );
    await until(() => t.messages.some((m) => m.type === 'image.end'));
    const bytes = Buffer.concat(t.imageParts),
      begin = t.messages.find((m) => m.type === 'image.begin');
    assert.ok(bytes.length > 8000);
    assert.equal(bytes.length, begin.length);
    assert.equal(bytes.subarray(0, 4).toString(), 'NMP1');
    assert.equal(bytes[12], 4);
    assert.equal(
      t.messages.filter((m) => m.type === 'command' && m.payload.voice_feedback).length,
      0,
    );
    assert.ok(!t.hub.state('board').last_voice.result_display_error);
  } finally {
    await t.close();
  }
});

test('bounded diagnostic capture with mild loss never transcribes or executes ambient speech', async () => {
  const t = await setup();
  try {
    t.send({
      type: 'audio.start',
      stream_id: 'diagnostic',
      sample_rate: 16000,
      channels: 1,
      sample_bits: 16,
      frame_samples: 320,
      diagnostic: true,
    });
    await until(() =>
      t.messages.some((m) => m.type === 'audio.ready' && m.stream_id === 'diagnostic'),
    );
    for (let n = 0; n < 100; n++)
      if (n !== 50) {
        const b = Buffer.alloc(645);
        b[0] = 0x41;
        b.writeUInt32LE(n, 1);
        t.sendBinary(b);
      }
    t.send({
      type: 'audio.end',
      stream_id: 'diagnostic',
      chunks: 100,
      complete: true,
      dropped_samples: 320,
      error: 'none',
    });
    await until(() => t.hub.state('board').last_voice.stage === 'diagnostic_complete');
    assert.equal(t.hub.state('board').last_voice.missing_samples, 320);
    assert.equal(t.asrs.length, 0);
    assert.equal(t.adapter.runs.length, 0);
  } finally {
    await t.close();
  }
});
