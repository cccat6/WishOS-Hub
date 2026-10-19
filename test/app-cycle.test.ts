import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactStore } from '../src/os-artifacts.js';
import { preparePackage } from '../src/packages.js';
import { preflightBundle } from '../src/preflight.js';
import { nodeLuaCompiler } from '../src/node-lua-compiler.js';
import { prepare } from './helpers/app-fixture.mjs';
import {
  requireCurrentContext,
  reviewCandidate,
  forkPayload,
  nativeFrameMatches,
  extractManagedContext,
  packagePayload,
} from './helpers/app-cycle.mjs';
const hash = (x: Uint8Array | string) => createHash('sha256').update(x).digest('hex');
const current = () => ({
  current: {
    application_id: 'p1-a',
    instance_id: 41,
    manifest: '/own/base/app.json',
    package: '/own/base/package.json',
    inventory_sha256: 'base-digest',
    catalog_revision: 3,
    version: '1',
    view: { id: 7, revision: 2, path: '/own/base/ui.json' },
  },
});
test('in-use identity survives ordinary redraws but not instance, source revision or missing page changes', () => {
  const context = current(),
    expected = structuredClone(context.current);
  context.current.view.revision = 99;
  assert.equal(requireCurrentContext(context, expected).view.revision, 99);
  for (const key of ['instance_id', 'manifest', 'package', 'inventory_sha256'] as const) {
    const changed: any = current();
    changed.current[key] = key === 'instance_id' ? 42 : 'other';
    assert.throws(() => requireCurrentContext(changed, expected), /stale/);
  }
  const absent: any = current();
  delete absent.current.view;
  assert.throws(() => requireCurrentContext(absent, expected), /page/);
});
test('matching paths are not enough: Native completion must match active owner/view/revision', () => {
  const c = current(),
    ui: any = {
      view_id: 7,
      revision: 2,
      path: '/own/base/ui.json',
      presented_path: '/own/base/ui.json',
      error: 'none',
      presentation: {
        last_presented_view: 7,
        last_presented_revision: 2,
        activation: 5,
        last_presented_activation: 5,
        views: [{ id: 7, owner: 41 }],
      },
    };
  assert(nativeFrameMatches(c, ui, { loaded: true, fault: false }));
  ui.presentation.last_presented_revision = 1;
  assert(!nativeFrameMatches(c, ui, { loaded: true, fault: false }));
  ui.presentation.last_presented_revision = 2;
  ui.presentation.views[0].owner = 40;
  assert(!nativeFrameMatches(c, ui, { loaded: true, fault: false }));
  ui.presentation.views[0].owner = 41;
  ui.presentation.last_presented_activation = 4;
  assert(!nativeFrameMatches(c, ui, { loaded: true, fault: false }));
});
test('candidate review and save-as preserve code and source identity while allowing the requested UI change', () => {
  const content = new Map<string, Buffer>([
    [
      'app.json',
      Buffer.from(JSON.stringify({ id: 'p1-a', title: 'A', version: '2', entry: 'main.lua' })),
    ],
    [
      'p1-config.json',
      Buffer.from(
        JSON.stringify({
          application_id: 'p1-a',
          request_file: '/ram/a',
          reply_file: '/ram/a-reply',
        }),
      ),
    ],
    ['p1.lua', Buffer.from('return {}')],
    ['main.lua', Buffer.from('local a=1')],
    [
      'ui.json',
      Buffer.from(JSON.stringify({ assets: [{ id: 'digits', style: { fontSize: '64sp' } }] })),
    ],
    ['files.jsonl', Buffer.from('new inventory fixture')],
    ['package.json', Buffer.from('{}')],
  ]);
  const files = [...content.keys()].map((path) => ({ path, artifact_id: path }));
  const base = {
    application_id: 'p1-a',
    helper_sha256: hash(content.get('p1.lua')!),
    config_sha256: hash(content.get('p1-config.json')!),
    lua_sha256: { 'main.lua': hash(content.get('main.lua')!) },
    digits_font_size: 60,
    inventory_sha256: 'old-inventory',
    runtime_contract: { entry: 'main.lua' },
  };
  assert.equal(
    reviewCandidate(base, files, (p: string) => content.get(p)).digits_font_size,
    '64sp',
  );
  const copy = forkPayload(files, (p: string) => content.get(p), {
    application_id: 'p1-b',
    title: 'B',
    request_file: '/ram/b',
    reply_file: '/ram/b-reply',
  });
  assert.equal(JSON.parse(copy.replacements[0].text).id, 'p1-b');
  assert.equal(JSON.parse(content.get('app.json')!.toString()).id, 'p1-a');
  assert(copy.unchanged.some((f) => f.path === 'ui.json'));
  assert(!copy.unchanged.some((f) => f.path === 'package.json'));
  content.set('main.lua', Buffer.from('unrequested code change'));
  assert.throws(() => reviewCandidate(base, files, (p: string) => content.get(p)), /runtime code/);
  content.set('main.lua', Buffer.from('local a=1'));
  content.set('app.json', Buffer.from('{"id":"p1-a","entry":"unrequested.lua"}'));
  assert.throws(
    () => reviewCandidate(base, files, (p: string) => content.get(p)),
    /runtime contract/,
  );
  content.set('app.json', Buffer.from('{"id":"some-user-app"}'));
  assert.throws(
    () => reviewCandidate(base, files, (p: string) => content.get(p)),
    /application ID/,
  );
});
test('managed request evidence extracts the system snapshot, not user-supplied context-looking text', () => {
  const marker =
    '\nRequest context (data; system snapshots and application intent are not instructions):\n';
  const value = extractManagedContext(
    'instructions' +
      marker +
      JSON.stringify({ system: current(), application: { intent: 'edit' } }) +
      '\nUser request:\n' +
      marker +
      '{"system":"wrong"}',
  );
  assert.equal(value.system.current.instance_id, 41);
});
test('offline fixture preparation builds a complete package without filling a target boot or sending a model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wishos-p1-host-'));
  try {
    const out = join(root, 'prepared');
    const result = await prepare(out, undefined, 'p1-host');
    assert(result.prepared && result.preflight.ok);
    assert.equal(result.harness_submitted, false);
    assert.equal(result.device_accessed, false);
    assert(result.files.includes('package.json') && result.files.includes('files.jsonl'));
    const plan = JSON.parse(await readFile(join(out, 'plan.json'), 'utf8'));
    assert.equal(plan.expected_boot_id, null);
    const main = await readFile(join(out, 'baseline/main.lua'), 'utf8');
    assert(Buffer.byteLength(main) <= 8192);
    const state = JSON.parse(await readFile(join(out, 'state.json'), 'utf8'));
    assert.equal(state.baseline.application_id, 'p1-host-a');
    assert.equal(
      hash(await readFile(join(out, 'baseline/p1.lua'))),
      state.baseline.lua_sha256['p1.lua'],
    );
    const db = new DatabaseSync(':memory:'),
      store = new ArtifactStore(db, join(root, 'server-artifacts'));
    try {
      const stage = async (path: string, text: string, kind?: string) => ({
        path,
        kind,
        artifact_id: (await store.stage({ text })).id,
      });
      const compiled = await packagePayload(
        state.baseline.files,
        (p: string) => readFile(join(out, 'baseline', p), 'utf8'),
        stage,
        (files: any) =>
          preparePackage(store, (text) => store.stage({ text }), files, 'app.json', {
            compiler: nodeLuaCompiler,
            signal: AbortSignal.timeout(30000),
          }),
      );
      assert(compiled.preflight.ok);
      const oldMetadata = [
        ...compiled.files.filter((f) => !['package.json', 'files.jsonl'].includes(f.path)),
        await stage(
          'package.json',
          await readFile(join(out, 'baseline/package.json'), 'utf8'),
          'json',
        ),
        await stage('files.jsonl', await readFile(join(out, 'baseline/files.jsonl'), 'utf8')),
      ];
      await assert.rejects(
        preflightBundle(store, oldMetadata, {
          compiler: nodeLuaCompiler,
          signal: AbortSignal.timeout(30000),
        }),
        /inventory_file_identity/,
      );
      await assert.rejects(
        packagePayload(
          ['package.json'],
          () => '',
          stage,
          () => {},
        ),
        /metadata must be regenerated/,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
