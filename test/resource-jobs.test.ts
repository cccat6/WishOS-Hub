import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ResourceJobs } from '../src/resource-jobs.js';
import { HostJobStore } from '../src/connect/job-store.js';
import { ArtifactStore } from '../src/os-artifacts.js';
import { prepareImage } from '../src/connect/image.js';
import { RunnerHttpAdapter } from '../src/adapters/runner-http.js';
import sharp from 'sharp';
async function eventually(fn: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('timeout');
}
test('resource jobs retain identity, bound concurrency and distinguish interrupted delivery', async () => {
  const db = new DatabaseSync(':memory:'),
    store = new HostJobStore(db),
    jobs = new ResourceJobs(store, { concurrency: 1, timeoutMs: 1000 });
  let calls = 0,
    finish!: (v: unknown) => void;
  const execute = async () => {
    calls++;
    return new Promise((r) => (finish = r));
  };
  try {
    const a = jobs.submit('same', 'fingerprint', 'stage', execute);
    assert.equal(a.state, 'running');
    assert.equal(jobs.submit('same', 'fingerprint', 'stage', execute).id, a.id);
    assert.throws(() => jobs.submit('same', 'different', 'stage', execute), /identity_conflict/);
    assert.throws(() => jobs.submit('other', 'other', 'stage', execute), /busy/);
    await new Promise((r) => setTimeout(r, 0));
    finish({ id: 'artifact' });
    await jobs.wait(a.id);
    assert.equal(calls, 1);
    assert.equal(jobs.read(a.id).state, 'completed');
    jobs.submit(
      'delivery',
      'd',
      'deliver',
      async (signal) =>
        new Promise((_r, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    );
    await new Promise((r) => setTimeout(r, 0));
    jobs.cancel('delivery');
    await jobs.wait('delivery');
    assert.equal(jobs.read('delivery').state, 'unknown');
    store.save({
      id: 'crash',
      fingerprint: 'f',
      kind: 'deliver',
      state: 'running',
      created: 1,
      updated: 1,
    });
    const restarted = new HostJobStore(db);
    assert.equal(restarted.read('crash')!.state, 'unknown');
  } finally {
    await jobs.close();
    db.close();
  }
});
test('image preparation matches exact geometry/palette and failed upload leaves no partial artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wishos-image-')),
    db = new DatabaseSync(':memory:'),
    store = new ArtifactStore(db, root, 1024 * 1024);
  try {
    const source = await sharp({
      create: { width: 80, height: 40, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const staged = await store.stageStream(
      (async function* () {
        yield source;
      })(),
    );
    const image = await prepareImage(
      store,
      {
        artifact_id: staged.id,
        width: 24,
        height: 32,
        format: 'indexed8',
        palette: [
          [0, 0, 0],
          [255, 0, 0],
        ],
      },
      new AbortController().signal,
    );
    assert.equal(image.size, 24 * 32);
    await assert.rejects(
      store.stageStream(
        (async function* () {
          yield Buffer.alloc(100);
          throw Error('network_lost');
        })(),
      ),
      /network_lost/,
    );
    assert.equal((db.prepare('SELECT count(*) n FROM os_artifacts').get() as any).n, 2);
    await assert.rejects(
      prepareImage(
        store,
        { artifact_id: staged.id, width: 9000, height: 1 },
        new AbortController().signal,
      ),
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('runner shutdown aborts outstanding work and Hermes cancellation uses its real stop endpoint', async () => {
  const calls: string[] = [],
    fetcher: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === '/v1/runs') return Response.json({ run_id: 'run' });
      if (path.endsWith('/stop')) return Response.json({ status: 'stopping' });
      return new Promise((_r, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }),
      );
    };
  const adapter = new RunnerHttpAdapter(
    'hermes',
    { endpoint: 'http://localhost', timeoutMs: 2000 },
    fetcher,
  );
  const running = adapter.send('session', 'hi', () => {}).catch((e) => e.message);
  await eventually(async () => calls.includes('/v1/runs/run'));
  await adapter.interrupt('session');
  assert.equal(await running, 'harness_outcome_unknown');
  assert(calls.includes('/v1/runs/run/stop'));
  await adapter.close();
});
test('host artifact quota reserves concurrent work and reclaims expired or abandoned files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wishos-artifact-quota-')),
    db = new DatabaseSync(':memory:');
  const store = new ArtifactStore(db, root, 8, { maxStoredBytes: 10, ttlMs: 100000 });
  const bytes = (s: string) =>
    (async function* () {
      yield Buffer.from(s);
    })();
  try {
    const first = await store.stageStream(bytes('1234'), 4),
      second = await store.stageStream(bytes('5678'), 4);
    await assert.rejects(store.stageStream(bytes('1234'), 4), /storage_quota/);
    db.prepare('UPDATE os_artifacts SET created=0 WHERE id=?').run(first.id);
    const third = await store.stageStream(bytes('123456'), 6);
    assert.equal(third.size, 6);
    await assert.rejects(access(store.root + '/' + first.id));
    assert.equal(store.get(second.id).size, 4);
    // A process crash can leave a reserved partial file but never a ready artifact.
    const partial = join(root, 'abandoned');
    await (await import('node:fs/promises')).writeFile(partial, 'partial');
    db.prepare('INSERT INTO os_artifact_pending VALUES(?,?,?)').run('abandoned', partial, 8);
    db.prepare('UPDATE os_artifacts SET created=0').run();
    const next = await store.stageStream(bytes('ok'), 2);
    assert.equal(next.size, 2);
    await assert.rejects(access(partial));
    assert.equal((db.prepare('SELECT count(*) n FROM os_artifact_pending').get() as any).n, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('active admission is independent of the paginated history window', async () => {
  const db = new DatabaseSync(':memory:'),
    jobs = new ResourceJobs(new HostJobStore(db), { concurrency: 2, timeoutMs: 10000 });
  let finish!: () => void;
  try {
    jobs.submit('old-active', 'a', 'stage', () => new Promise<void>((r) => (finish = r)));
    await new Promise((r) => setImmediate(r));
    db.prepare('UPDATE resource_jobs SET updated=0 WHERE id=?').run('old-active');
    for (let i = 0; i < 105; i++) {
      jobs.submit('later-' + i, String(i), 'stage', async () => ({ ok: true }));
      await jobs.wait('later-' + i);
    }
    assert.equal(jobs.list().length, 100);
    assert(!jobs.list().some((j) => j.id === 'old-active'));
    assert.equal(jobs.activeCount, 1);
    finish();
    await jobs.wait('old-active');
    assert.equal(jobs.activeCount, 0);
  } finally {
    finish?.();
    await jobs.close();
    db.close();
  }
});

test('image preparation pins an expired source through concurrent artifact cleanup and releases it afterwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wishos-image-lease-')),
    db = new DatabaseSync(':memory:'),
    store = new ArtifactStore(db, root, 1024 * 1024);
  try {
    const image = await sharp({
      create: { width: 128, height: 128, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const source = await store.stageStream(
      (async function* () {
        yield image;
      })(),
      image.length,
    );
    db.prepare('UPDATE os_artifacts SET created=0 WHERE id=?').run(source.id);
    const preparing = prepareImage(
      store,
      {
        artifact_id: source.id,
        width: 128,
        height: 128,
        format: 'indexed8',
        palette: [
          [0, 0, 0],
          [255, 0, 0],
        ],
      },
      AbortSignal.timeout(5000),
    );
    await store.stage({ text: 'concurrent' });
    assert.equal((await preparing).size, 128 * 128);
    await store.stage({ text: 'after-release' });
    assert.throws(() => store.get(source.id), /artifact_not_found/);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
