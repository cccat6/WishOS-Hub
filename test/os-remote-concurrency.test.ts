import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { OsRemoteBridge, type DeviceRpc } from '../src/os-remote.js';
import { SqlRemoteJournal } from '../src/os-journal.js';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
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
      m === 'peek'
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
