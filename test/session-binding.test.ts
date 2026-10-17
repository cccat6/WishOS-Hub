import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Hub } from '../src/hub.js';
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

test('a learned default belongs to its runtime profile and does not leak into a replacement profile', async () => {
  const store = new Store(':memory:'),
    adapter = new SessionFixture();
  const device = {
    id: 'board',
    token: '',
    adapter,
    runtimeId: 'runner',
    runtimeScope: 'profile-a',
  };
  const hub = new Hub({ store, adminToken: '', devices: [device] });
  try {
    const one = hub.startRun('board', { request_id: 'learn', text: 'first' });
    await until(() => store.run(one.id).status === 'completed');
    assert.equal(hub.state('board').session_id, 'created-session');
    device.runtimeScope = 'profile-b';
    assert.equal(hub.state('board').session_id, null);
    const status = await hub.controlSessions('board', {
      kind: 'session_control',
      operation: 'status',
    });
    assert.equal(status.default_session, null);
    assert.equal(adapter.sent.length, 1);
    device.runtimeScope = 'profile-a';
    assert.equal(hub.state('board').session_id, 'created-session');
  } finally {
    await hub.close();
    store.close();
  }
});

test('settled Harness failure remains failed without replay and does not block a new request; unknown failure still requires reconciliation', async () => {
  const { HarnessTurnEnded } = await import('../src/adapters/errors.js');
  for (const known of [true, false]) {
    const store = new Store(':memory:');
    let calls = 0;
    const adapter = new SessionFixture();
    adapter.send = async () => {
      calls++;
      if (calls === 1)
        throw known
          ? new HarnessTurnEnded('Codex turn interrupted', 'interrupted')
          : Error('lost native turn receipt');
      return 'fresh result';
    };
    const hub = new Hub({
      store,
      adminToken: '',
      devices: [{ id: 'board', token: '', sessionId: 'fixed-session', adapter }],
    });
    try {
      const old = hub.startRun('board', { request_id: 'old', text: 'old request' });
      await until(() => store.run(old.id).status !== 'running');
      assert.equal(store.run(old.id).status, known ? 'failed' : 'uncertain');
      assert.equal(hub.startRun('board', { request_id: 'old', text: 'old request' }).id, old.id);
      assert.equal(calls, 1);
      if (known) {
        const fresh = hub.startRun('board', { request_id: 'fresh', text: 'fresh request' });
        await until(() => store.run(fresh.id).status === 'completed');
        assert.equal(calls, 2);
      } else
        assert.throws(
          () => hub.startRun('board', { request_id: 'fresh', text: 'fresh request' }),
          /requires_reconciliation/,
        );
    } finally {
      await hub.close();
      store.close();
    }
  }
});
