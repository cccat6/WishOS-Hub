import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';
import type { HarnessAdapter } from '../src/adapters/types.js';
import { authoringInstructions } from '../src/guidance.js';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(check: () => unknown) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error('voice condition timeout');
}
class Controlled implements HarnessAdapter {
  name = 'controlled';
  capabilities = { interrupt: false, approval: false, steer: true };
  runs: { session: string; text: string; result: ReturnType<typeof deferred<string>> }[] = [];
  steers: { session: string; text: string }[] = [];
  openGate?: ReturnType<typeof deferred<string>>;
  steerGate?: ReturnType<typeof deferred<boolean>>;
  async open(id?: string) {
    return this.openGate ? this.openGate.promise : (id ?? 'new-session');
  }
  send(session: string, text: string) {
    const result = deferred<string>();
    this.runs.push({ session, text, result });
    return result.promise;
  }
  async steer(session: string, text: string) {
    this.steers.push({ session, text });
    return this.steerGate ? this.steerGate.promise : true;
  }
  async close() {
    for (const r of this.runs) r.result.resolve('closed');
    this.openGate?.resolve('new-session');
    this.steerGate?.resolve(false);
  }
}
async function setup(options: { unbound?: boolean; noSteer?: boolean } = {}) {
  const store = new Store(':memory:'),
    adapter = new Controlled(),
    asrs: ReturnType<typeof deferred<string>>[] = [];
  if (options.noSteer) (adapter as any).steer = undefined;
  const device = {
    id: 'board',
    token: '',
    adapter,
    sessionId: options.unbound ? undefined : 'fixed',
  };
  const hub = new Hub({
    store,
    adminToken: '',
    devices: [device],
    asr: {
      transcribe() {
        const d = deferred<string>();
        asrs.push(d);
        return d.promise;
      },
    },
  });
  const address = (await hub.listen(0, '127.0.0.1')) as any,
    base = 'http://127.0.0.1:' + address.port;
  async function api(id: string, action: string, data?: unknown) {
    const response = await fetch(
      base + '/api/devices/board/audio/' + id + (action ? '/' + action : ''),
      {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      },
    );
    const body = await response.json();
    if (!response.ok) throw Error(body.error);
    return body;
  }
  const start = (id: string, config: Record<string, unknown> = {}) =>
    api(id, 'begin', { sample_rate: 16000, ...config });
  async function end(id: string) {
    const packet = Buffer.alloc(91);
    packet[0] = 0x42;
    packet.writeUInt16LE(160, 9);
    await api(id, 'chunks', {
      chunks: [
        { sequence: 0, samples: 160, sample_start: '0', adpcm_b64: packet.toString('base64') },
      ],
    });
    await api(id, 'finish', { produced_samples: '160', capture_failed: false });
  }
  const voice = async (id: string) => {
    await start(id);
    await end(id);
  };
  const status = (id: string) => api(id, '');
  const accepted = async (id: string) => {
    let value: any;
    for (let i = 0; i < 300; i++) {
      value = await status(id);
      if (['accepted', 'failed'].includes(value.state)) return value;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw Error('audio timeout');
  };
  async function close() {
    for (const a of asrs) a.resolve('closed');
    await hub.close();
    store.close();
  }
  return { hub, store, device, adapter, asrs, start, end, voice, status, accepted, close };
}
test('managed speech creation and follow-up modification retain the same authoring entry when steering', async () => {
  const t = await setup();
  try {
    for (const [index, text] of ['创建时钟应用', '修改时钟为每分钟更新'].entries()) {
      const id = 'managed-' + index;
      await t.start(id, { managed_request: true });
      await t.end(id);
      await until(() => t.asrs.length > index);
      t.asrs[index].resolve(text);
      const receipt = await t.accepted(id);
      assert.equal(receipt.state, 'accepted');
      const sent = index === 0 ? t.adapter.runs[0] : t.adapter.steers[0];
      assert.equal(sent.session, 'fixed');
      assert(sent.text.includes(authoringInstructions()));
      assert(sent.text.endsWith(text));
    }
    assert.equal(t.adapter.runs.length, 1);
    assert.equal(t.adapter.steers.length, 1);
  } finally {
    await t.close();
  }
});
test('compressed follow-up steers active native session and creates no display/UI work', async () => {
  const t = await setup();
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('first');
    await t.accepted('one');
    await t.voice('two');
    await until(() => t.asrs.length === 2);
    t.asrs[1].resolve('second');
    await t.accepted('two');
    assert.equal(t.adapter.runs.length, 1);
    assert.deepEqual(t.adapter.steers, [{ session: 'fixed', text: 'second' }]);
    assert.equal(
      (t.store.db.prepare('SELECT status FROM voice_steers').get() as any).status,
      'accepted',
    );
    assert.equal(
      t.store.db.prepare("SELECT name FROM sqlite_master WHERE name='commands'").get(),
      undefined,
    );
  } finally {
    await t.close();
  }
});
test('rapid recordings preserve release order during ASR and initial session creation', async () => {
  const t = await setup({ unbound: true });
  t.adapter.openGate = deferred<string>();
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    await t.voice('two');
    await t.voice('three');
    assert.equal(t.asrs.length, 1);
    t.asrs[0].resolve('first');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.adapter.runs.length, 0);
    t.adapter.openGate.resolve('new-session');
    await until(() => t.asrs.length === 2);
    t.asrs[1].resolve('second');
    await until(() => t.asrs.length === 3);
    t.asrs[2].resolve('third');
    await t.accepted('three');
    assert.equal(t.adapter.runs.length, 1);
    assert.deepEqual(t.adapter.steers, [
      { session: 'new-session', text: 'second' },
      { session: 'new-session', text: 'third' },
    ]);
  } finally {
    await t.close();
  }
});
test('delayed follow-up ASR continues captured session after turn completion, even after default changes', async () => {
  const t = await setup();
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('first');
    await t.accepted('one');
    await t.voice('two');
    await until(() => t.asrs.length === 2);
    t.store.bind('board', 'controlled', 'different');
    t.adapter.runs[0].result.resolve('first final');
    await until(() => !t.hub.state('board').active_run);
    t.asrs[1].resolve('second');
    await t.accepted('two');
    assert.equal(t.adapter.runs[1].session, 'fixed');
    assert.equal(t.adapter.steers.length, 0);
  } finally {
    await t.close();
  }
});
test('completion/steer race continues once only on known rejection; an uncertain steer is never replayed', async () => {
  for (const uncertain of [false, true]) {
    const t = await setup();
    t.adapter.steerGate = deferred<boolean>();
    try {
      await t.voice('one');
      await until(() => t.asrs.length === 1);
      t.asrs[0].resolve('first');
      await t.accepted('one');
      await t.voice('two');
      await until(() => t.asrs.length === 2);
      t.asrs[1].resolve('second');
      await until(() => t.adapter.steers.length === 1);
      t.adapter.runs[0].result.resolve('final');
      if (uncertain) t.adapter.steerGate.reject(Error('rpc_outcome_unknown'));
      else t.adapter.steerGate.resolve(false);
      await t.accepted('two');
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
test('no native steering waits for current completion and continues in same session', async () => {
  const t = await setup({ noSteer: true });
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('first');
    await t.accepted('one');
    await t.voice('two');
    await until(() => t.asrs.length === 2);
    t.asrs[1].resolve('second');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.adapter.runs.length, 1);
    t.adapter.runs[0].result.resolve('done');
    await t.accepted('two');
    assert.equal(t.adapter.runs[1].session, 'fixed');
  } finally {
    await t.close();
  }
});
test('recording pins session at begin despite default selection changing during ASR', async () => {
  const t = await setup();
  try {
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.device.sessionId = 'changed';
    t.asrs[0].resolve('first');
    await t.accepted('one');
    assert.equal(t.adapter.runs[0].session, 'fixed');
    assert.equal(t.hub.state('board').session_id, 'changed');
  } finally {
    await t.close();
  }
});
test('voice during targeted turn follows that session without changing saved default', async () => {
  const t = await setup();
  try {
    t.hub.startRun('board', { request_id: 'targeted', text: 'first', session_id: 'other' });
    await until(() => t.adapter.runs.length === 1);
    await t.voice('one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('follow-up');
    await t.accepted('one');
    assert.equal(t.adapter.steers[0].session, 'other');
    assert.equal(t.hub.state('board').session_id, 'fixed');
  } finally {
    await t.close();
  }
});

test('compressed managed voice preserves frozen current/origin/intent context and steers only the same app instance', async () => {
  const t = await setup();
  try {
    const context = {
      system: {
        current: {
          application_id: 'voice',
          instance_id: 7,
          catalog_revision: 3,
          view: { id: 11, revision: 2, path: '/voice/ui.json' },
        },
        launch_origin: {
          application_id: 'clock',
          instance_id: 6,
          catalog_revision: 2,
          entry: '/apps/clock/main.lua',
        },
      },
      application: { intent: { effect: 'application_update', target_context: 'launch_origin' } },
    };
    await t.start('context-one', {
      managed_request: true,
      managed_request_id: 'outer-one',
      request_context: context,
      request_scope: 'instance-7',
    });
    await t.end('context-one');
    await until(() => t.asrs.length === 1);
    t.asrs[0].resolve('修改刚才的应用');
    await t.accepted('context-one');
    const sentContext = (text: string) =>
      JSON.parse(text.split('not instructions):\n')[1].split('\nUser request:\n')[0]);
    assert.deepEqual(sentContext(t.adapter.runs[0].text), context);
    assert(t.adapter.runs[0].text.includes('WishOS 托管请求 outer-one'));
    await t.start('context-two', {
      managed_request: true,
      managed_request_id: 'outer-two',
      request_context: context,
      request_scope: 'instance-8',
    });
    await t.end('context-two');
    await until(() => t.asrs.length === 2);
    t.asrs[1].resolve('新实例的请求');
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(t.adapter.steers.length, 0);
    assert.equal(t.adapter.runs.length, 1);
    t.adapter.runs[0].result.resolve('完成');
    await t.accepted('context-two');
    assert.equal(t.adapter.runs.length, 2);
    assert.equal(t.adapter.runs[1].session, 'fixed');
    assert(t.adapter.runs[1].text.endsWith('新实例的请求'));
    await t.start('context-three', {
      managed_request: true,
      request_context: context,
      request_scope: 'instance-8',
    });
    await t.end('context-three');
    await until(() => t.asrs.length === 3);
    t.asrs[2].resolve('接着上一个');
    await t.accepted('context-three');
    assert.equal(t.adapter.steers.length, 1);
    assert.deepEqual(sentContext(t.adapter.steers[0].text), context);
  } finally {
    await t.close();
  }
});
