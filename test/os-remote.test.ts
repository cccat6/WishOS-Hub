import test from 'node:test';
import assert from 'node:assert/strict';
import { OsRemoteBridge, harnessRoute, type DeviceRpc } from '../src/os-remote.js';
test('remote bridge retries lost completion without repeating an application side effect', async () => {
  let calls = 0,
    acks = 0;
  const rpc: DeviceRpc = async (_p, m, a) => {
    if (m === 'peek')
      return {
        boot_id: 'a',
        ok: true,
        result: {
          id: 1,
          request_id: 'a:1',
          state: 'queued',
          route: 'service',
          payload: { value: 2 },
        },
      };
    ++acks;
    assert.equal(a.expected_boot_id, 'a');
    if (acks === 1) throw Error('lost response');
    return { boot_id: 'a', ok: true, result: {} };
  };
  const bridge = new OsRemoteBridge(rpc, {
    service: async () => {
      ++calls;
      return { value: 3 };
    },
  });
  const signal = new AbortController().signal;
  await bridge.poll(signal);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(bridge.poll(signal));
  await bridge.poll(signal);
  assert.equal(calls, 1);
  assert.equal(acks, 2);
});
test('unknown remote routes fail explicitly without executing a handler', async () => {
  let completion: any;
  const rpc: DeviceRpc = async (_p, m, a) =>
    m === 'peek'
      ? {
          boot_id: 'a',
          ok: true,
          result: { id: 1, state: 'queued', route: 'missing', payload: {} },
        }
      : ((completion = a), { boot_id: 'a', ok: true, result: {} });
  await new OsRemoteBridge(rpc, {}).poll(new AbortController().signal);
  assert.equal(completion.ok, false);
  assert.equal(completion.result.error, 'route_not_registered');
});
test('Harness route retains request and session identity and reports acceptance only', async () => {
  let body: any;
  const f = (async (_u: any, a: any) => {
    body = JSON.parse(a.body);
    return new Response(JSON.stringify({ id: 'run' }), { status: 202 });
  }) as typeof fetch;
  const result = await harnessRoute(
    'http://localhost',
    'screen',
    '',
    f,
  )(
    {
      id: 1,
      request_id: 'b:1',
      route: 'agent',
      payload: { text: 'do this', session_id: 'existing' },
    },
    new AbortController().signal,
  );
  assert.equal(body.session_id, 'existing');
  assert.equal(body.request_id, 'b:1');
  assert.deepEqual(result, { state: 'accepted', run_id: 'run' });
});

test('invalid service results do not replay successful side effects after a lost acknowledgement', async () => {
  let calls = 0,
    acks = 0;
  const rpc: DeviceRpc = async (_p, m, a) => {
    if (m === 'peek')
      return {
        boot_id: 'a',
        ok: true,
        result: { id: 1, state: 'queued', route: 'cycle', payload: {} },
      };
    assert.equal(a.ok, false);
    assert.deepEqual(a.result, { error: 'result_not_json' });
    if (++acks === 1) throw Error('lost');
    return { boot_id: 'a', ok: true, result: {} };
  };
  const bridge = new OsRemoteBridge(rpc, {
    cycle: async () => {
      ++calls;
      const value: any = {};
      value.self = value;
      return value;
    },
  });
  await bridge.poll(new AbortController().signal);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(bridge.poll(new AbortController().signal));
  await bridge.poll(new AbortController().signal);
  assert.equal(calls, 1);
});
