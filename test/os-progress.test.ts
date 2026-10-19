import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteProgress, boundedMessage } from '../src/os-progress.js';
import type { RemoteRequest } from '../src/os-remote.js';
const request = (): RemoteRequest => ({
  id: 3,
  request_id: 'own-key',
  boot_id: 'boot',
  route: 'wishos.ai',
  payload: {},
});
test('progress negotiates, coalesces bounded UTF8, identity and rate; failed delivery cannot fail result', async () => {
  const p = new RemoteProgress(),
    r = request(),
    calls: any[] = [];
  let fail = false;
  const rpc = async (path: string, method: string, args: any) => {
    calls.push({ path, method, args });
    if (method === 'describe')
      return {
        boot_id: 'boot',
        ok: true,
        result: {
          methods: 'read,progress',
          progress: { format: 'wishos-progress/1', text_limit_bytes: 512, min_interval_ms: 1000 },
        },
      };
    if (fail) throw Error('offline');
    return { boot_id: 'boot', ok: true, result: {} };
  };
  p.update(r, { stage: 'received' });
  await p.flush(r, rpc);
  p.update(r, { stage: 'receiving' });
  p.update(r, { stage: 'executing', source: 'harness', text: '猫'.repeat(500) });
  await p.flush(r, rpc);
  assert.equal(calls.filter((x) => x.method === 'progress').length, 1);
  await p.flush(r, rpc, true);
  const latest = calls.at(-1).args;
  assert.equal(latest.id, 3);
  assert.equal(latest.request_id, 'own-key');
  assert.equal(latest.expected_boot_id, 'boot');
  assert.equal(latest.sequence, 3);
  assert.equal(latest.progress.source, 'harness');
  assert(Buffer.byteLength(latest.progress.text) <= 512);
  assert(!latest.progress.text.includes('�'));
  p.update(r, { stage: 'preparing' });
  fail = true;
  await p.flush(r, rpc, true);
  fail = false;
  await p.flush(r, rpc, true);
  assert.equal(calls.at(-1).args.sequence, 4);
  p.reconnect();
  await p.flush(r, rpc);
  assert.equal(calls.at(-1).args.sequence, 4);
  p.update(r, { stage: 'received' });
  p.reconnect();
  await p.flush(r, rpc);
  assert.equal(calls.at(-1).args.progress.stage, 'preparing');
  p.retire(r);
  const n = calls.length;
  await p.flush(r, rpc, true);
  assert.equal(calls.length, n);
});
test('undeclared capability, changed boot and retired task never receive progress', async () => {
  const p = new RemoteProgress(),
    r = request();
  p.update(r, { stage: 'received' });
  let updates = 0;
  await p.flush(r, async () => ({ boot_id: 'boot', ok: true, result: { methods: 'read' } }));
  await p.flush(
    r,
    async () => {
      updates++;
      throw Error('should be disabled');
    },
    true,
  );
  assert.equal(updates, 0);
  const next = { ...r, boot_id: 'newboot' };
  p.update(next, { stage: 'received' });
  await p.flush(next, async () => ({
    boot_id: 'wrongboot',
    ok: true,
    result: { methods: 'read,progress' },
  }));
  assert.equal(boundedMessage('é猫', 4), 'é');
});

test('escaped control text respects serialized native bound and retired progress cannot send after discovery', async () => {
  const p = new RemoteProgress(),
    r = request();
  let sent: any;
  p.update(r, { stage: 'executing', source: 'harness', text: '\u0001'.repeat(512) });
  const rpc = async (path: string, method: string, args: any) => {
    if (method === 'describe')
      return {
        boot_id: 'boot',
        ok: true,
        result: {
          methods: 'progress',
          progress: {
            format: 'wishos-progress/1',
            text_limit_bytes: 512,
            serialized_limit_bytes: 1024,
            min_interval_ms: 1000,
          },
        },
      };
    sent = args;
    return { boot_id: 'boot', ok: true, result: {} };
  };
  await p.flush(r, rpc);
  assert(Buffer.byteLength(JSON.stringify(sent.progress)) <= 1024);
  assert(Buffer.byteLength(sent.progress.text) <= 512);
  const other = new RemoteProgress();
  other.update(r, { stage: 'received' });
  let active = true;
  await other.flush(
    r,
    async () => {
      active = false;
      return {
        boot_id: 'boot',
        ok: true,
        result: { methods: 'progress', progress: { format: 'wishos-progress/1' } },
      };
    },
    false,
    () => active,
  );
  assert.equal(active, false);
});

test('real bridge settles advisory delivery before meaningful final result; transport error never replays work', async () => {
  const { OsRemoteBridge } = await import('../src/os-remote.js');
  let executions = 0;
  const order: string[] = [];
  let completed = false;
  const bridge = new OsRemoteBridge(
    async (path, method, args) => {
      if (path === '/sys/capabilities')
        return {
          boot_id: 'boot',
          ok: true,
          result: { methods: 'progress', progress: { format: 'wishos-progress/1' } },
        };
      if (method === 'peek')
        return {
          boot_id: 'boot',
          ok: true,
          result:
            Number(args.after_id) < 3 && !completed
              ? { ...request(), state: 'queued' }
              : { state: 'empty' },
        };
      if (method === 'progress') {
        order.push('progress');
        throw Error('advisory_transport_failure');
      }
      if (method === 'complete') {
        completed = true;
        order.push('complete');
        assert.equal(args.result, 'meaningful result');
        return { boot_id: 'boot', ok: true, result: {} };
      }
      return {
        boot_id: 'boot',
        ok: true,
        result: { pending: !completed, requests: completed ? [] : [{ id: 3, state: 'queued' }] },
      };
    },
    {
      'wishos.ai': async (r) => {
        executions++;
        r.reportProgress?.({ stage: 'executing', source: 'harness', text: '公开进度' });
        return 'meaningful result';
      },
    },
  );
  try {
    await bridge.poll(new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    await bridge.poll(new AbortController().signal);
    assert(completed);
    assert.equal(executions, 1);
    assert(order.indexOf('progress') < order.indexOf('complete'));
  } finally {
    bridge.close();
  }
});
