import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { recoverDispatch } from '../src/dispatch-recovery.js';
import { TransportFailure } from '../src/transport-failure.js';
import { ControlGuard } from '../src/control-receipts.js';
import { HostControlStore } from '../src/connect/control-store.js';
import { guardedInvocation } from '../src/preflight-call.js';
import { nodeLuaCompiler } from '../src/node-lua-compiler.js';
test('only readonly loss or proven-unsent calls can recover; a dispatched write is never replayed', async () => {
  let count = 0,
    waits = 0;
  const recovery = {
    windowMs: 100,
    wait: async () => {
      waits++;
    },
  };
  assert.equal(
    await recoverDispatch(
      async () => {
        if (++count === 1) throw new TransportFailure('rpc_outcome_unknown', true);
        return 'read';
      },
      recovery,
      true,
    ),
    'read',
  );
  assert.equal(count, 2);
  count = 0;
  await assert.rejects(
    recoverDispatch(
      async () => {
        count++;
        throw new TransportFailure('rpc_outcome_unknown', true);
      },
      recovery,
      false,
    ),
    /unknown/,
  );
  assert.equal(count, 1);
  count = 0;
  assert.equal(
    await recoverDispatch(
      async () => {
        if (++count === 1) throw new TransportFailure('device_not_ready', false);
        return 'write';
      },
      recovery,
      false,
    ),
    'write',
  );
  assert.equal(count, 2);
  assert.equal(waits, 2);
});
test('read recovery is bounded and a changed boot refuses the mutation', async () => {
  let attempts = 0;
  await assert.rejects(
    recoverDispatch(
      async () => {
        attempts++;
        throw new TransportFailure('rpc_outcome_unknown', true);
      },
      {
        windowMs: 1,
        wait: async () => {
          await new Promise((r) => setTimeout(r, 5));
        },
      },
      true,
    ),
    /unknown/,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    recoverDispatch(
      async () => {
        throw new TransportFailure('device_not_ready', false);
      },
      {
        wait: async () => {
          throw new TransportFailure('device_boot_changed_before_dispatch', false);
        },
      },
      false,
    ),
    /boot_changed/,
  );
});
test('install preflight can repeat a lost readonly status before dispatching install exactly once', async () => {
  let reads = 0,
    installed = 0;
  const rpc = async (path: string, method: string) => {
    if (path === '/sys/capabilities')
      return {
        ok: true,
        boot_id: 'b',
        result: {
          package_install: { validation_required: true },
          package_validation: { status_method: 'validation' },
        },
      };
    if (method === 'validation') {
      if (++reads === 1) throw new TransportFailure('rpc_outcome_unknown', true);
      return {
        ok: true,
        boot_id: 'b',
        result: {
          state: 'validated',
          manifest: '/r/app.json',
          package: '/r/package.json',
          revision: 1,
        },
      };
    }
    installed++;
    return { ok: true, boot_id: 'b', result: { application_id: 'a' } };
  };
  const reply = await guardedInvocation(
    rpc,
    nodeLuaCompiler,
    '/sys/apps',
    'install',
    { manifest: '/r/app.json', package: '/r/package.json', validation_id: 1, expected_revision: 1 },
    AbortSignal.timeout(1000),
    'b',
    { wait: async () => {} },
  );
  assert(reply.ok);
  assert.equal(reads, 2);
  assert.equal(installed, 1);
});
test('known-not-dispatched status survives receipt cache loss without becoming uncertain or executing again', async () => {
  const db = new DatabaseSync(':memory:'),
    store = new HostControlStore(db),
    guard = new ControlGuard(store);
  let calls = 0;
  const input = {
      path: '/sys/apps',
      method: 'install',
      args: {},
      request_id: 'id',
      expected_boot_id: 'b',
    },
    describe = async () => ({ ok: true, boot_id: 'b', result: { read_methods: 'read' } });
  try {
    const rejected = await guard.invoke('d', input, describe, async () => {
      calls++;
      return {
        ok: false,
        boot_id: 'b',
        error: 'preflight_transport_unavailable',
        result: { not_dispatched: true },
      };
    });
    assert(!rejected.ok);
    db.exec("UPDATE control_receipts SET value=json_remove(value,'$.response')");
    const restored = await new ControlGuard(new HostControlStore(db)).invoke(
      'd',
      input,
      describe,
      async () => {
        calls++;
        return { ok: true, boot_id: 'b', result: {} };
      },
    );
    assert.equal((restored.result as any).not_dispatched, true);
    assert.equal((restored.result as any).executed_again, false);
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});

test('a socket send exception closes the peer and preserves dispatched versus not-sent semantics', async () => {
  const { EventEmitter } = await import('node:events'),
    { OsRpcSocket } = await import('../src/os-rpc-socket.js'),
    { frames } = await import('./fixtures/wire-device.js');
  const socket: any = new EventEmitter();
  socket.readyState = 1;
  socket.bufferedAmount = 0;
  socket.send = () => {
    throw Error('socket failed');
  };
  socket.terminate = () => socket.emit('close');
  socket.close = () => socket.emit('close');
  const peer = new OsRpcSocket(socket);
  for (const frame of frames({ type: 'hello', abi: 'wishos-rpc/1', boot_id: 'b' }))
    socket.emit('message', frame, true);
  await assert.rejects(
    peer.rpc('/dev/x', 'write', {}),
    (e: any) => e instanceof TransportFailure && e.dispatched === true,
  );
  await assert.rejects(
    peer.rpc('/dev/x', 'write', {}),
    (e: any) => e instanceof TransportFailure && e.dispatched === false,
  );
});

test('exhausted readonly capability preparation cannot mark the requested mutation as dispatched', async () => {
  const db = new DatabaseSync(':memory:'),
    guard = new ControlGuard(new HostControlStore(db));
  let mutations = 0;
  try {
    const reply = await guard.invoke(
      'd',
      {
        path: '/sys/apps',
        method: 'install',
        args: {},
        expected_boot_id: 'b',
        request_id: 'before-claim',
      },
      async () => {
        throw new TransportFailure('rpc_outcome_unknown', true);
      },
      async () => {
        mutations++;
        return { ok: true, boot_id: 'b', result: {} };
      },
      {
        windowMs: 1,
        wait: async () => {
          await new Promise((r) => setTimeout(r, 5));
        },
      },
    );
    assert.equal(reply.ok, false);
    assert.equal((reply.result as any).not_dispatched, true);
    assert.equal(reply.error, 'control_preparation_unavailable');
    assert.equal(mutations, 0);
  } finally {
    db.close();
  }
});
