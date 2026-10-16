import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { OsRemoteBridge, type DeviceRpc } from '../src/os-remote.js';
import { SqlRemoteJournal } from '../src/os-journal.js';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
test('the real native idle snapshot uses a boolean pending field and retires a missing request without another peek', async () => {
  const snapshot = JSON.parse(
    await readFile(new URL('./fixtures/native-remote-outbox-idle.json', import.meta.url), 'utf8'),
  );
  let peeks = 0,
    retired = false,
    finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const rpc: DeviceRpc = async (_p, m, a) => ({
    ok: true,
    boot_id: 'b',
    result:
      m === 'read'
        ? snapshot
        : m === 'peek'
          ? (peeks++,
            Number(a.after_id) < 1
              ? { id: 1, request_id: 'b:1', route: 'slow', payload: {} }
              : { state: 'empty' })
          : {},
  });
  const bridge = new OsRemoteBridge(rpc, {
    slow: async (_r, s) => {
      s.addEventListener('abort', () => {
        retired = true;
      });
      await gate;
      return {};
    },
  });
  try {
    await bridge.poll(new AbortController().signal);
    await turn();
    const initial = peeks;
    await bridge.poll(new AbortController().signal);
    assert.equal(retired, true);
    assert.equal(bridge.discoveryMode, 'snapshot');
    assert.equal(peeks, initial);
    assert.equal(bridge.pendingCount, 0);
  } finally {
    bridge.close();
    finish();
    await turn();
  }
});
test('independent services run concurrently; close does not publish late callbacks or replay uncertain work', async () => {
  const db = new DatabaseSync(':memory:'),
    journal = new SqlRemoteJournal(db, 'dev');
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  let executions = 0;
  const requests = [
    { id: 1, request_id: 'one', state: 'queued', route: 'slow', payload: {} },
    { id: 2, request_id: 'two', state: 'queued', route: 'quick', payload: {} },
  ];
  const done: any[] = [];
  const rpc: DeviceRpc = async (_p, m, a) => ({
    boot_id: 'b',
    ok: true,
    result:
      m === 'read'
        ? {
            pending: requests.length > 0,
            requests: requests.map((r) => ({ id: r.id, state: 'queued' })),
          }
        : m === 'peek'
          ? (requests.find((r) => r.id > Number(a.after_id ?? 0)) ?? { state: 'empty' })
          : (done.push(a),
            requests.splice(
              requests.findIndex((r) => r.id === a.id),
              1,
            ),
            {}),
  });
  const bridge = new OsRemoteBridge(
    rpc,
    {
      slow: async () => {
        executions++;
        await gate;
        return { late: true };
      },
      quick: () => ({ quick: true }),
    },
    { journal },
  );
  await bridge.poll(new AbortController().signal);
  await turn();
  await bridge.poll(new AbortController().signal);
  assert.equal(done.length, 1);
  assert.equal(done[0].id, 2);
  bridge.close();
  db.close();
  finish();
  await turn();
  assert.equal(executions, 1);
});
test('a complete outbox list retires cancelled work and discovers only new payloads during a live stream', async () => {
  const requests = [{ id: 1, request_id: 'one', route: 'slow', payload: {}, state: 'queued' }];
  let peeks = 0,
    reads = 0,
    cancelled = false,
    finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const completed: number[] = [];
  const rpc: DeviceRpc = async (_p, m, a) => {
    let result: any = {};
    if (m === 'read') {
      reads++;
      result = {
        pending: requests.length > 0,
        requests: requests.map((r) => ({ id: r.id, state: 'queued' })),
      };
    } else if (m === 'peek') {
      peeks++;
      result = requests.find((r) => r.id > Number(a.after_id)) ?? { state: 'empty' };
    } else if (m === 'complete') {
      completed.push(Number(a.id));
      requests.splice(
        requests.findIndex((r) => r.id === a.id),
        1,
      );
    }
    return { ok: true, boot_id: 'b', result };
  };
  const bridge = new OsRemoteBridge(rpc, {
    slow: async (_r, s) => {
      s.addEventListener('abort', () => {
        cancelled = true;
      });
      await gate;
      return {};
    },
    quick: () => ({ done: true }),
  });
  const signal = new AbortController().signal;
  try {
    await bridge.poll(signal);
    await turn();
    const initial = peeks;
    await bridge.poll(signal);
    await bridge.poll(signal);
    assert.equal(peeks, initial);
    assert.equal(cancelled, false);
    assert.equal(reads, 2);
    requests.push({ id: 2, request_id: 'two', route: 'quick', payload: {}, state: 'queued' });
    await bridge.poll(signal);
    await turn();
    await bridge.poll(signal);
    assert.equal(peeks, initial + 1);
    assert.deepEqual(completed, [2]);
    requests.length = 0;
    await bridge.poll(signal);
    assert.equal(cancelled, true);
    assert.equal(bridge.pendingCount, 0);
  } finally {
    bridge.close();
    finish();
    await turn();
  }
});
test('incomplete advisory listings fall back to payload discovery without treating absent entries as cancellation', async () => {
  const requests = [{ id: 1, request_id: 'one', route: 'slow', payload: {}, state: 'queued' }];
  let cancelled = false,
    peeks = 0,
    finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const rpc: DeviceRpc = async (_p, m, a) => ({
    ok: true,
    boot_id: 'b',
    result:
      m === 'read'
        ? { pending: 2, requests: [{ id: 1, state: 'queued' }], more: true }
        : m === 'peek'
          ? (peeks++, requests.find((r) => r.id > Number(a.after_id)) ?? { state: 'empty' })
          : {},
  });
  const bridge = new OsRemoteBridge(rpc, {
    slow: async (_r, s) => {
      s.addEventListener('abort', () => {
        cancelled = true;
      });
      await gate;
      return {};
    },
  });
  try {
    await bridge.poll(new AbortController().signal);
    await turn();
    const prior = peeks;
    requests.push({ id: 2, request_id: 'two', route: 'slow', payload: {}, state: 'queued' });
    await bridge.poll(new AbortController().signal);
    await turn();
    assert(peeks > prior);
    assert.equal(bridge.pendingCount, 2);
    assert.equal(cancelled, false);
  } finally {
    bridge.close();
    finish();
    await turn();
  }
});
test('unsupported list probing is bounded to a boot and is reconsidered after replacement', async () => {
  let boot = 'a',
    probes = 0,
    finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const signals: AbortSignal[] = [];
  const rpc: DeviceRpc = async (_p, m, a) =>
    m === 'read'
      ? (probes++, { ok: false, boot_id: boot, error: 'unsupported_method', result: {} })
      : {
          ok: true,
          boot_id: boot,
          result:
            m === 'peek' && Number(a.after_id) < 1
              ? { id: 1, request_id: boot + ':1', route: 'slow', payload: {} }
              : { state: 'empty' },
        };
  const bridge = new OsRemoteBridge(rpc, {
    slow: async (_r, s) => {
      signals.push(s);
      await gate;
      return {};
    },
  });
  const signal = new AbortController().signal;
  try {
    await bridge.poll(signal);
    await turn();
    await bridge.poll(signal);
    await bridge.poll(signal);
    assert.equal(probes, 1);
    boot = 'b';
    await bridge.poll(signal);
    await turn();
    assert(signals[0].aborted);
    await bridge.poll(signal);
    assert.equal(probes, 2);
    assert.equal(bridge.pendingCount, 1);
  } finally {
    bridge.close();
    finish();
    await turn();
  }
});
test('durable remote receipts survive bridge reconstruction and object key order changes', async () => {
  const db = new DatabaseSync(':memory:'),
    journal = new SqlRemoteJournal(db, 'd');
  let executed = 0,
    completions = 0;
  let payload = { a: 1, b: 2 };
  const rpc: DeviceRpc = async (_p, m, a) => {
    if (m === 'peek')
      return {
        boot_id: 'b',
        ok: true,
        result:
          Number(a.after_id ?? 0) < 1
            ? { id: 1, request_id: 'fixed', route: 'x', payload }
            : { state: 'empty' },
      };
    if (++completions === 1) throw Error('dropped acknowledgement');
    return { boot_id: 'b', ok: true, result: {} };
  };
  const first = new OsRemoteBridge(
    rpc,
    {
      x: () => {
        executed++;
        return 42;
      },
    },
    { journal },
  );
  await first.poll(new AbortController().signal).catch(() => {});
  await turn();
  await first.poll(new AbortController().signal).catch(() => {});
  first.close();
  payload = { b: 2, a: 1 };
  const second = new OsRemoteBridge(
    rpc,
    {
      x: () => {
        executed++;
        return 43;
      },
    },
    { journal },
  );
  await second.poll(new AbortController().signal);
  assert.equal(executed, 1);
  assert.equal(journal.get('fixed')?.state, 'acknowledged');
  second.close();
  db.close();
});
test('closing while a poll is in flight cannot start a late application action', async () => {
  let reply!: (r: any) => void,
    executed = 0;
  const delayed = new Promise<any>((resolve) => (reply = resolve));
  const rpc: DeviceRpc = async () => delayed;
  const bridge = new OsRemoteBridge(rpc, {
    x: () => {
      executed++;
      return {};
    },
  });
  const pending = bridge.poll(new AbortController().signal);
  bridge.close();
  reply({ boot_id: 'b', ok: true, result: { id: 1, request_id: 'late', route: 'x', payload: {} } });
  await pending;
  await turn();
  assert.equal(executed, 0);
});
