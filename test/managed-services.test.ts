import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, parseManagedResult } from '../src/os-artifacts.js';
import { managedAgentRoute } from '../src/os-agent.js';
test('staging streams on server and transfers verified chunks without source URL on device', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wish-assets-')),
    db = new DatabaseSync(':memory:');
  try {
    const store = new ArtifactStore(db, dir, 10000),
      a = await store.stage({ text: 'x'.repeat(6000) });
    let received = 0;
    const calls: any[] = [];
    const rpc = async (path: string, method: string, args: any) => {
      calls.push({ path, method, args });
      if (method === 'chunk') {
        assert(args.hex.length <= 2048);
        received += args.hex.length / 2;
      }
      return {
        ok: true,
        boot_id: 'b',
        result:
          method === 'mounts'
            ? { providers: [] }
            : method === 'begin'
              ? { id: 1, chunk_bytes: 1024 }
              : method === 'commit'
                ? { root: '/card/downloads/v1' }
                : {},
      };
    };
    const result = await store.deliver(
      rpc,
      [{ path: 'book.txt', artifact_id: a.id }],
      new AbortController().signal,
    );
    assert.equal(received, 6000);
    assert.equal(result.transfer_id, 1);
    assert.equal(calls.at(-1).method, 'commit');
    assert(calls.every((c) => !('url' in c.args)));
    await assert.rejects(() =>
      store.deliver(rpc, [{ path: '../bad', artifact_id: a.id }], new AbortController().signal),
    );
    assert.throws(() =>
      parseManagedResult(
        '{"format":"wishos-result/1","effects":[{"kind":"application","path":"app.json"}]}',
      ),
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('application AI response and large data reference are separated from system effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wish-ai-')),
    db = new DatabaseSync(':memory:');
  try {
    const store = new ArtifactStore(db, dir);
    let started = 0;
    const rpc = async (_p: string, m: string, _a: any) => ({
      ok: true,
      boot_id: 'b',
      result:
        m === 'mounts'
          ? { providers: [] }
          : m === 'describe'
            ? {
                result_format: 'wishos-result/2',
                action_limit_bytes: 2048,
                inline_result_limit_bytes: 1536,
              }
            : m === 'begin'
              ? { id: 2, chunk_bytes: 1024 }
              : m === 'commit'
                ? { root: '/card/reply' }
                : {},
    });
    const route = managedAgentRoute({
      rpc,
      artifacts: store,
      start: () => {
        ++started;
        return { id: 'r' };
      },
      status: () => ({ status: 'completed', result: 'hello' }),
    });
    const request = {
      id: 1,
      request_id: 'request1',
      route: 'wishos.ai',
      payload: { format: 'wishos-ai/2', input: { text: 'hi' } },
    };
    const result: any = await route(request, new AbortController().signal);
    assert.equal(result.actions[0].data.text, 'hello');
    assert.equal(started, 1);
    const large = managedAgentRoute({
      rpc,
      artifacts: store,
      start: () => ({ id: 'r2' }),
      status: () => ({
        status: 'completed',
        result: JSON.stringify({
          format: 'wishos-result/2',
          actions: Array.from({ length: 200 }, (_, i) => ({
            type: 'application',
            data: { text: 'Step ' + i },
          })),
        }),
      }),
    });
    const a: any = await large(request, new AbortController().signal);
    assert.equal(a.sequence.format, 'jsonl');
    assert.equal(a.transfer_id, 2);
    assert.equal(a.actions, undefined);
    const row = db
      .prepare('SELECT path FROM os_artifacts ORDER BY created DESC LIMIT 1')
      .get() as any;
    const lines = (await readFile(row.path, 'utf8'))
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.equal(lines.length, 200);
    assert.equal(lines[199].data.text, 'Step 199');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('telemetry accepts only declared payloads, deduplicates retries, stores no anonymous identity', async () => {
  const module = await import(new URL('../telemetry/worker.mjs', import.meta.url).href),
    worker = module.default;
  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../telemetry/schema.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string) => ({
    bind: (...values: any[]) => ({ run: async () => db.prepare(sql).run(...values), sql, values }),
  });
  const env = {
    DB: {
      prepare,
      batch: async (rows: any[]) => {
        db.exec('BEGIN');
        try {
          const results = rows.map((r) => db.prepare(r.sql).run(...r.values));
          db.exec('COMMIT');
          return results;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
  };
  const send = async (data: any) =>
    worker.fetch(
      new Request('https://telemetry.wishos.dev/v1/ingest', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
      env,
    );
  try {
    const registration = {
      format: 'wishos-telemetry/1',
      kind: 'registration',
      receipt: 'a'.repeat(32),
      device_id: 'test-device',
      boot_id: 'test-boot',
    };
    assert.equal((await send(registration)).status, 200);
    assert.equal((await send(registration)).status, 200);
    assert.equal((db.prepare('SELECT count(*) n FROM boots').get() as any).n, 1);
    const aggregate = {
      format: 'wishos-telemetry/1',
      kind: 'aggregate',
      receipt: 'b'.repeat(32),
      metrics: { application_calls: '2', errors: '1' },
    };
    assert.equal((await send(aggregate)).status, 200);
    assert.equal((await send({ ...aggregate, device_id: 'bad' })).status, 400);
    assert.equal((await send({ ...aggregate, metrics: { text: 'secret' } })).status, 400);
    assert.equal((await send(aggregate)).status, 200);
    assert.equal((db.prepare('SELECT count(*) n FROM aggregates').get() as any).n, 1);
    const row = db.prepare('SELECT * FROM aggregates').get()!;
    assert(!('device_id' in row));
    assert.equal((await send({ pad: 'x'.repeat(3000) })).status, 400);
  } finally {
    db.close();
  }
});
test('same-boot interrupted transfer resumes its acknowledged offset and does not abort on disconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wish-resume-')),
    db = new DatabaseSync(':memory:');
  try {
    const store = new ArtifactStore(db, root),
      artifact = await store.stage({ text: 'a'.repeat(6000) });
    let offset = 0,
      opened = false,
      lost = true,
      aborts = 0;
    const rpc = async (_p: string, m: string, a: any) => {
      let result: any = {};
      if (m === 'read') result = { policy: { targets: [] } };
      if (m === 'mounts') result = { providers: [] };
      if (m === 'begin') result = { id: 4, chunk_bytes: 1024, files_complete: 0 };
      if (m === 'file') {
        opened = true;
        result = { file_offset: String(offset) };
      }
      if (m === 'chunk') {
        assert(opened);
        assert.equal(Number(a.offset), offset);
        offset += a.hex.length / 2;
        if (lost && offset === 2048) {
          lost = false;
          throw Error('device_disconnected');
        }
      }
      if (m === 'abort') aborts++;
      if (m === 'commit') result = { root: '/card/new' };
      return { ok: true, boot_id: 'b', result };
    };
    await assert.rejects(
      () =>
        store.deliver(
          rpc,
          [{ path: 'book', artifact_id: artifact.id }],
          new AbortController().signal,
        ),
      /disconnected/,
    );
    assert.equal(aborts, 0);
    await store.deliver(
      rpc,
      [{ path: 'book', artifact_id: artifact.id }],
      new AbortController().signal,
    );
    assert.equal(offset, 6000);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('binary artifacts stream without text encoding, enforce quota and remove partial files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wish-binary-')),
    db = new DatabaseSync(':memory:');
  try {
    const store = new ArtifactStore(db, dir, 4096);
    async function* bytes() {
      yield Buffer.from([0, 255, 128]);
      yield Buffer.alloc(1024, 42);
    }
    const a = await store.stageStream(bytes());
    assert.equal(a.size, 1027);
    assert.deepEqual(
      (await readFile(store.get(a.id).path)).subarray(0, 3),
      Buffer.from([0, 255, 128]),
    );
    await assert.rejects(store.stageStream(bytes(), 1000), /artifact_too_large/);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(dir), [a.id]);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(store.stageStream(bytes(), 4096, abort.signal));
    assert.deepEqual(await readdir(dir), [a.id]);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('application and system actions share one verified bundle and retain their order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wish-both-')),
    db = new DatabaseSync(':memory:');
  try {
    const artifacts = new ArtifactStore(db, dir),
      file = await artifacts.stage({ text: 'x'.repeat(2000) }),
      methods: string[] = [];
    const rpc = async (_path: string, method: string) => {
      methods.push(method);
      return {
        ok: true,
        boot_id: 'b',
        result:
          method === 'mounts'
            ? { providers: [] }
            : method === 'describe'
              ? {
                  result_format: 'wishos-result/2',
                  action_limit_bytes: 2048,
                  inline_result_limit_bytes: 1536,
                }
              : method === 'begin'
                ? { id: 4, chunk_bytes: 1024 }
                : method === 'commit'
                  ? { root: '/card/result' }
                  : {},
      };
    };
    const actions = [
      { type: 'application', recipient: 'origin', data: { resource: { $asset: 'reply.txt' } } },
      {
        type: 'system',
        path: '/services/time',
        method: 'configure',
        args: { settings: { timezone: 'UTC0' } },
      },
      { type: 'application', recipient: 'foreground', data: { text: 'done' } },
    ];
    const route = managedAgentRoute({
      rpc,
      artifacts,
      start: () => ({ id: 'mixed-result' }),
      status: () => ({
        status: 'completed',
        result: JSON.stringify({
          format: 'wishos-result/2',
          files: [{ path: 'reply.txt', artifact_id: file.id }],
          actions,
        }),
      }),
    });
    const result: any = await route(
      {
        id: 1,
        request_id: 'mixed',
        route: 'wishos.ai',
        payload: { format: 'wishos-ai/2', input: { text: 'mixed sequence' } },
      },
      new AbortController().signal,
    );
    assert.deepEqual(result.actions, actions);
    assert.equal(result.transfer_id, 4);
    assert.equal(methods.at(-1), 'commit');
    assert.equal(result.files, undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancelled delivery still sends its cleanup RPC after the transfer signal aborts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wish-cancel-')),
    db = new DatabaseSync(':memory:');
  try {
    const store = new ArtifactStore(db, dir),
      artifact = await store.stage({ text: 'x'.repeat(2048) });
    const controller = new AbortController(),
      methods: string[] = [];
    const rpc = async (_path: string, method: string, args: any) => {
      methods.push(method);
      if (method === 'begin') assert.equal(args.remote_request_id, 7);
      if (method === 'chunk') controller.abort();
      return {
        ok: true,
        boot_id: 'b',
        result:
          method === 'mounts'
            ? { providers: [] }
            : method === 'begin'
              ? { id: 3, chunk_bytes: 1024 }
              : {},
      };
    };
    await assert.rejects(
      store.deliver(rpc, [{ path: 'file', artifact_id: artifact.id }], controller.signal, 'b', 7),
    );
    assert.equal(methods.at(-1), 'abort');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
