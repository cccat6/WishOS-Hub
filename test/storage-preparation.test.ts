import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactStore } from '../src/os-artifacts.js';
import { TransportFailure } from '../src/transport-failure.js';
import { ResourceReplyError } from '../src/resource-reply-error.js';
import type { DeviceRpc } from '../src/os-remote.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wishos-storage-selection-')),
    db = new DatabaseSync(':memory:'),
    source = new ArtifactStore(db, root);
  const asset = await source.stage({ text: 'transfer bytes' }),
    calls: any[] = [];
  const f = {
    source,
    asset,
    calls,
    targets: ['user', 'flash'],
    providers: [
      {
        id: 'user',
        available: true,
        free_needs_refresh: true,
        free_bytes: '100000',
        volume_capacity_bytes: '200000',
        prepare: { path: '/media/card', method: 'mount', args: {} },
        capacity_refresh: { path: '/media/card', method: 'space', args: {} },
      },
      {
        id: 'flash',
        available: true,
        free_needs_refresh: true,
        free_bytes: '100000',
        volume_capacity_bytes: '200000',
        capacity_refresh: { path: '/storage/internal', method: 'space', args: {} },
      },
    ] as any[],
    begins: 0,
    refreshes: [] as string[],
    operationReads: 0,
    releases: 0,
    received: Buffer.alloc(0),
    selected: '',
    beginError: undefined as ((attempt: number) => string | Error | undefined) | undefined,
    onRefresh: undefined as ((id: string) => void) | undefined,
    refreshFailure: undefined as string | undefined,
    asyncRefresh: true,
    paginated: true,
  };
  const rpc: DeviceRpc = async (path, method, args) => {
    calls.push({ path, method, args });
    let result: any = {};
    if (path === '/sys/transfers') {
      if (method === 'read')
        result = { policy: { targets: f.targets.map((provider) => ({ provider })) } };
      else if (method === 'begin') {
        f.begins++;
        const error = f.beginError?.(f.begins);
        if (error instanceof Error) throw error;
        if (error) return { ok: false, boot_id: 'b', error, result: {} };
        const selected = f.targets
          .map((id) => f.providers.find((p) => p.id === id))
          .find((p) => p?.available);
        if (selected.free_needs_refresh)
          return { ok: false, boot_id: 'b', error: 'storage_space_refresh_required', result: {} };
        f.selected = selected.id;
        result = { id: 1, chunk_bytes: 4, files_complete: 0, state: 'receiving' };
      } else if (method === 'file') result = { file_offset: 0 };
      else if (method === 'chunk') {
        assert.equal(Number(args.offset), f.received.length);
        f.received = Buffer.concat([f.received, Buffer.from(args.hex as string, 'hex')]);
      } else if (method === 'commit') result = { root: '/' + f.selected + '/transfer' };
    } else if (path === '/fs' && method === 'mounts') {
      const list = f.paginated
        ? [
            ...Array.from({ length: 4 }, (_, i) => ({ id: 'unrelated' + i, available: true })),
            ...f.providers,
          ]
        : f.providers;
      const cursor = Number(args.cursor ?? 0),
        next = Math.min(list.length, cursor + 4);
      result = {
        providers: structuredClone(list.slice(cursor, next)),
        more: next < list.length,
        next_cursor: next,
      };
    } else if (path === '/sys/capabilities')
      result = f.asyncRefresh ? { async: { space: { success_events: ['space_ready'] } } } : {};
    else if (path === '/sys/operations') {
      if (method === 'request') {
        const p = f.providers.find((p) => p.capacity_refresh.path === args.path);
        assert(p);
        f.refreshes.push(p.id);
        if (!f.refreshFailure) {
          p.free_needs_refresh = false;
          p.free_bytes = '120000';
          f.onRefresh?.(p.id);
        }
        result = { completion_id: 8 };
      } else if (method === 'read') {
        f.operationReads++;
        result = {
          ready: true,
          event: f.refreshFailure ? 'space_failed' : 'space_ready',
          data: f.refreshFailure ? { error: f.refreshFailure } : {},
        };
      } else if (method === 'release') f.releases++;
    } else if (method === 'space') {
      const p = f.providers.find((p) => p.capacity_refresh.path === path);
      assert(p);
      f.refreshes.push(p.id);
      p.free_needs_refresh = false;
      p.free_bytes = '120000';
      f.onRefresh?.(p.id);
    } else throw Error('unexpected operation ' + path + ':' + method);
    return { ok: true, boot_id: 'b', result };
  };
  return Object.assign(f, {
    rpc,
    deliver: () =>
      source.deliver(
        rpc,
        [{ path: 'picture.bin', artifact_id: asset.id }],
        AbortSignal.timeout(3000),
        'b',
      ),
    close: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  });
}

test('delivery refreshes the ordered selected SD provider from paginated metadata without mounting an available volume or touching Flash', async () => {
  const f = await fixture();
  try {
    const r = await f.deliver();
    assert.equal(r.root, '/user/transfer');
    assert.deepEqual(f.refreshes, ['user']);
    assert.equal(f.releases, 1);
    assert.equal(f.begins, 1);
    assert.equal(f.received.toString(), 'transfer bytes');
    assert(
      !f.calls.some(
        (c) => c.method === 'mount' || c.path === '/dev/flash' || c.path === '/storage/internal',
      ),
    );
    assert(f.calls.some((c) => c.path === '/fs' && c.args.cursor === 4));
  } finally {
    await f.close();
  }
});

test('an explicit pre-effect capacity refusal rereads policy, refreshes the actual provider and retries begin once with the same identity', async () => {
  const f = await fixture();
  try {
    f.providers.forEach((p) => (p.free_needs_refresh = false));
    f.beginError = (n) => (n === 1 ? 'storage_space_refresh_required' : undefined);
    await f.deliver();
    assert.equal(f.begins, 2);
    assert.deepEqual(f.refreshes, ['user']);
    const begins = f.calls.filter((c) => c.path === '/sys/transfers' && c.method === 'begin');
    assert.deepEqual(begins[0].args, begins[1].args);
    assert(
      f.calls
        .slice(f.calls.indexOf(begins[0]) + 1, f.calls.indexOf(begins[1]))
        .some((c) => c.path === '/fs' && c.method === 'mounts'),
    );
  } finally {
    await f.close();
  }
});

test('capacity selection changes after refresh are rechecked and only the newly selected provider is prepared', async () => {
  const f = await fixture();
  try {
    f.onRefresh = (id) => {
      if (id === 'user') {
        const p = f.providers.find((p) => p.id === 'user');
        p.available = false;
        delete p.prepare;
      }
    };
    const r = await f.deliver();
    assert.equal(r.root, '/flash/transfer');
    assert.deepEqual(f.refreshes, ['user', 'flash']);
    assert.equal(f.begins, 1);
  } finally {
    await f.close();
  }
});

test('capacity and quota refusals do not silently fall through to the next available provider or retry to a deadline', async () => {
  for (const error of ['storage_space_refresh_required', 'storage_quota_exceeded']) {
    const f = await fixture();
    try {
      f.providers.forEach((p) => (p.free_needs_refresh = false));
      f.beginError = () => error;
      await assert.rejects(
        f.deliver(),
        (e: any) =>
          e instanceof ResourceReplyError &&
          e.message === error &&
          e.transfer_receipt.state === 'rejected',
      );
      assert.equal(f.begins, error === 'storage_space_refresh_required' ? 2 : 1);
      assert.deepEqual(f.refreshes, error === 'storage_space_refresh_required' ? ['user'] : []);
      assert.equal(f.received.length, 0);
    } finally {
      await f.close();
    }
  }
});

test('a lost mutating begin response never becomes a capacity refresh/retry even when the transport message resembles a storage refusal', async () => {
  const f = await fixture();
  try {
    f.providers.forEach((p) => (p.free_needs_refresh = false));
    f.beginError = () => new TransportFailure('storage_space_refresh_required', true);
    await assert.rejects(
      f.deliver(),
      (e: any) => e.transfer_receipt.state === 'begin_outcome_unknown',
    );
    assert.equal(f.begins, 1);
    assert.deepEqual(f.refreshes, []);
  } finally {
    await f.close();
  }
});

test('failed tracked capacity refresh releases the operation and preserves the known begin refusal without another begin', async () => {
  const f = await fixture();
  try {
    f.providers.forEach((p) => (p.free_needs_refresh = false));
    f.beginError = () => 'storage_space_refresh_required';
    f.refreshFailure = 'media_removed';
    await assert.rejects(
      f.deliver(),
      (e: any) => e.message === 'media_removed' && e.transfer_receipt.state === 'rejected',
    );
    assert.equal(f.begins, 1);
    assert.equal(f.releases, 1);
    assert.equal(f.received.length, 0);
  } finally {
    await f.close();
  }
});

test('synchronous capacity refresh follows the declared provider path and stale refreshed capacity cannot start a transfer', async () => {
  const f = await fixture();
  try {
    f.asyncRefresh = false;
    f.onRefresh = (id) => {
      f.providers.find((p) => p.id === id).free_needs_refresh = true;
    };
    await assert.rejects(f.deliver(), /storage_space_refresh_required/);
    assert.equal(f.begins, 0);
    assert.deepEqual(f.refreshes, ['user']);
    assert.equal(f.releases, 0);
  } finally {
    await f.close();
  }
});

test('a complete application package follows selected-provider refresh through native validation, install and launch', async () => {
  const f = await fixture();
  const { PackageDevice } = await import('./fixtures/package-device.js');
  const { preparePackage, deployPackage } = await import('../src/packages.js');
  const { nodeLuaCompiler } = await import('../src/node-lua-compiler.js');
  const d = new PackageDevice();
  d.paginatedMounts = true;
  d.preparationReady = true;
  d.descriptions['/sys/apps'].install_providers = ['card'];
  let stale = true,
    scans = 0,
    releases = 0;
  const rpc: DeviceRpc = async (path, method, args) => {
    if (path === '/sys/capabilities' && args.path === '/media/card')
      return {
        ok: true,
        boot_id: d.boot,
        result: { async: { space: { success_events: ['capacity_ready'] } } },
      };
    if (path === '/sys/operations' && method === 'request' && args.path === '/media/card') {
      scans++;
      stale = false;
      return { ok: true, boot_id: d.boot, result: { completion_id: 55 } };
    }
    if (path === '/sys/operations' && args.id === 55) {
      if (method === 'release') releases++;
      return {
        ok: true,
        boot_id: d.boot,
        result: { ready: true, event: 'capacity_ready', data: {} },
      };
    }
    if (path === '/sys/transfers' && method === 'begin' && stale)
      return { ok: false, boot_id: d.boot, error: 'storage_space_refresh_required', result: {} };
    const r = await d.rpc(path, method, args);
    if (path === '/fs' && method === 'mounts')
      for (const p of r.result.providers ?? [])
        if (p.id === 'card')
          Object.assign(p, {
            free_needs_refresh: stale,
            free_bytes: '1000000',
            volume_capacity_bytes: '2000000',
            capacity_refresh: { path: '/media/card', method: 'space', args: {} },
          });
    return r;
  };
  try {
    const manifest = await f.source.stage({
      text: JSON.stringify({
        format: 'wishos-app/1',
        id: 'storage-app',
        title: 'Storage app',
        entry: 'main.lua',
      }),
    });
    const lua = await f.source.stage({ text: 'return {on_start=function() end}' });
    const signal = AbortSignal.timeout(5000);
    const prepared = await preparePackage(
      f.source,
      (text, s) => f.source.stage({ text }, s),
      [
        { path: 'app.json', artifact_id: manifest.id },
        { path: 'main.lua', artifact_id: lua.id },
      ],
      'app.json',
      { compiler: nodeLuaCompiler, signal },
    );
    const result = await deployPackage(f.source, prepared.files, rpc, d.boot, {
      compiler: nodeLuaCompiler,
      signal,
      activate: true,
    });
    assert.equal(result.state, 'activated');
    assert.equal(d.active, 'storage-app');
    assert.equal(d.installed?.application.id, 'storage-app');
    assert.equal(scans, 1);
    assert.equal(releases, 1);
    assert(!d.calls.some((c) => c.path === '/dev/flash' || c.method === 'mount'));
  } finally {
    await f.close();
  }
});

test('resource jobs retain rejected transfer identity after bounded capacity recovery fails', async () => {
  const f = await fixture();
  const { ResourceJobs } = await import('../src/resource-jobs.js');
  const { HostJobStore } = await import('../src/connect/job-store.js');
  const db = new DatabaseSync(':memory:'),
    jobs = new ResourceJobs(new HostJobStore(db));
  try {
    f.providers.forEach((p) => (p.free_needs_refresh = false));
    f.beginError = () => 'storage_space_refresh_required';
    jobs.submit('delivery', 'fingerprint', 'deliver', () => f.deliver());
    await jobs.wait('delivery');
    const result = jobs.read('delivery');
    assert.equal(result.state, 'failed');
    assert.equal(result.error, 'storage_space_refresh_required');
    assert.equal(result.receipts?.transfer?.state, 'rejected');
    assert(result.receipts?.transfer?.request_id);
    assert.equal(f.begins, 2);
  } finally {
    await jobs.close();
    db.close();
    await f.close();
  }
});

test('boot replacement or cancellation during a capacity scan prevents begin and still releases its tracked operation', async () => {
  for (const mode of ['boot', 'cancel']) {
    const f = await fixture(),
      controller = new AbortController();
    const rpc: DeviceRpc = async (path, method, args) => {
      const r = await f.rpc(path, method, args);
      if (path === '/sys/operations' && method === 'read') {
        if (mode === 'boot') r.boot_id = 'replacement';
        else controller.abort(Error('caller_cancelled'));
      }
      return r;
    };
    try {
      await assert.rejects(
        f.source.deliver(
          rpc,
          [{ path: 'asset.bin', artifact_id: f.asset.id }],
          controller.signal,
          'b',
        ),
        mode === 'boot' ? /device_boot_changed/ : /caller_cancelled/,
      );
      assert.equal(f.begins, 0);
      assert.equal(f.releases, 1);
    } finally {
      await f.close();
    }
  }
});

test('managed delivery does not requeue an exhausted explicit capacity refusal as a generic transport retry', async () => {
  const f = await fixture();
  const { managedAgentRoute } = await import('../src/os-agent.js');
  const { RetryableRemoteError } = await import('../src/os-remote.js');
  let attempts = 0;
  f.source.preflight = async () => undefined as any;
  f.source.deliver = async () => {
    attempts++;
    throw new ResourceReplyError({
      ok: false,
      boot_id: 'b',
      error: 'storage_space_refresh_required',
      result: {},
    });
  };
  const route = managedAgentRoute({
    artifacts: f.source,
    rpc: async () => ({
      ok: true,
      boot_id: 'b',
      result: {
        result_format: 'wishos-result/2',
        inline_result_limit_bytes: 1536,
        action_limit_bytes: 1536,
      },
    }),
    start: () => ({ id: 'run' }),
    status: () => ({
      status: 'completed',
      result: JSON.stringify({
        format: 'wishos-result/2',
        files: [{ path: 'asset.bin', artifact_id: f.asset.id }],
        actions: [{ type: 'application', data: { resource: { $asset: 'asset.bin' } } }],
      }),
    }),
  });
  try {
    await assert.rejects(
      Promise.resolve(
        route(
          {
            id: 1,
            request_id: 'b:1',
            boot_id: 'b',
            route: 'wishos.ai',
            payload: { format: 'wishos-ai/2', input: { text: 'show' } },
          },
          new AbortController().signal,
        ),
      ),
      (e: any) =>
        e instanceof ResourceReplyError &&
        !(e instanceof RetryableRemoteError) &&
        e.message === 'storage_space_refresh_required',
    );
    assert.equal(attempts, 1);
  } finally {
    await f.close();
  }
});

test('stale selected capacity without a declared refresh refuses before begin instead of refreshing another volume', async () => {
  const f = await fixture();
  try {
    delete f.providers[0].capacity_refresh;
    await assert.rejects(f.deliver(), /storage_space_refresh_required/);
    assert.equal(f.begins, 0);
    assert.deepEqual(f.refreshes, []);
    assert.equal(f.received.length, 0);
  } finally {
    await f.close();
  }
});

test('a rejected capacity-operation release cannot be reported as prepared storage or begin a transfer', async () => {
  const f = await fixture();
  const rpc: DeviceRpc = async (path, method, args) => {
    const r = await f.rpc(path, method, args);
    return path === '/sys/operations' && method === 'release'
      ? { ok: false, boot_id: 'b', error: 'operation_active', result: {} }
      : r;
  };
  try {
    await assert.rejects(
      f.source.deliver(
        rpc,
        [{ path: 'asset.bin', artifact_id: f.asset.id }],
        AbortSignal.timeout(1000),
        'b',
      ),
      /operation_active/,
    );
    assert.equal(f.begins, 0);
    assert.equal(f.releases, 1);
  } finally {
    await f.close();
  }
});

test('unknown capacity-request outcome is retained as preparation uncertainty without another request or begin', async () => {
  const f = await fixture();
  let requests = 0;
  const rpc: DeviceRpc = async (path, method, args) => {
    if (path === '/sys/operations' && method === 'request') {
      requests++;
      throw new TransportFailure('rpc_outcome_unknown', true);
    }
    return f.rpc(path, method, args);
  };
  try {
    await assert.rejects(
      f.source.deliver(
        rpc,
        [{ path: 'asset.bin', artifact_id: f.asset.id }],
        AbortSignal.timeout(1000),
        'b',
      ),
      (e: any) =>
        e.transfer_receipt.state === 'not_dispatched' &&
        e.transfer_receipt.preparation.state === 'outcome_unknown' &&
        e.transfer_receipt.preparation.path === '/media/card',
    );
    assert.equal(requests, 1);
    assert.equal(f.begins, 0);
  } finally {
    await f.close();
  }
});

test('managed result handling never turns unknown begin/preparation mutations into a generic delivery retry', async () => {
  for (const phase of ['begin', 'prepare']) {
    const f = await fixture();
    let attempts = 0;
    const { managedAgentRoute } = await import('../src/os-agent.js');
    const { RetryableRemoteError } = await import('../src/os-remote.js');
    const receipt =
      phase === 'begin'
        ? { state: 'begin_outcome_unknown' }
        : { state: 'not_dispatched', preparation: { state: 'outcome_unknown' } };
    f.source.preflight = async () => undefined as any;
    f.source.deliver = async () => {
      attempts++;
      throw Object.assign(new TransportFailure('rpc_outcome_unknown', true), {
        transfer_receipt: receipt,
      });
    };
    const route = managedAgentRoute({
      artifacts: f.source,
      rpc: async () => ({
        ok: true,
        boot_id: 'b',
        result: {
          result_format: 'wishos-result/2',
          inline_result_limit_bytes: 1536,
          action_limit_bytes: 1536,
        },
      }),
      start: () => ({ id: 'run' }),
      status: () => ({
        status: 'completed',
        result: JSON.stringify({
          format: 'wishos-result/2',
          files: [{ path: 'asset.bin', artifact_id: f.asset.id }],
          actions: [{ type: 'application', data: { resource: { $asset: 'asset.bin' } } }],
        }),
      }),
    });
    try {
      await assert.rejects(
        Promise.resolve(
          route(
            {
              id: 1,
              request_id: 'b:1',
              boot_id: 'b',
              route: 'wishos.ai',
              payload: { format: 'wishos-ai/2', input: { text: 'show' } },
            },
            new AbortController().signal,
          ),
        ),
        (e: any) =>
          e instanceof TransportFailure &&
          !(e instanceof RetryableRemoteError) &&
          e.transfer_receipt === receipt,
      );
      assert.equal(attempts, 1);
    } finally {
      await f.close();
    }
  }
});

test('failed or unknown media-state reads cannot masquerade as absent media and authorize Flash fallback', async () => {
  for (const mode of ['failed', 'unknown', 'absent']) {
    const f = await fixture();
    f.providers[0].available = false;
    const rpc: DeviceRpc = async (path, method, args) => {
      if (path === '/media/card' && method === 'mount')
        return { ok: false, boot_id: 'b', error: 'filesystem_unsupported', result: {} };
      if (path === '/media/card' && method === 'read')
        return mode === 'failed'
          ? { ok: false, boot_id: 'b', error: 'link_io_failed', result: {} }
          : { ok: true, boot_id: 'b', result: mode === 'absent' ? { link_ready: false } : {} };
      return f.rpc(path, method, args);
    };
    try {
      const run = () =>
        f.source.deliver(
          rpc,
          [{ path: 'asset.bin', artifact_id: f.asset.id }],
          AbortSignal.timeout(1000),
          'b',
        );
      if (mode === 'absent') {
        assert.equal((await run()).root, '/flash/transfer');
        assert.deepEqual(f.refreshes, ['flash']);
      } else {
        await assert.rejects(
          run(),
          mode === 'failed' ? /link_io_failed/ : /filesystem_unsupported/,
        );
        assert.equal(f.begins, 0);
        assert.deepEqual(f.refreshes, []);
      }
    } finally {
      await f.close();
    }
  }
});
