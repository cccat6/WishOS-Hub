// Offline package fixture only. No device, cloud or Harness operations.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { prepareFixture, runtimeContract } from './app-cycle.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const save = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');
export async function prepare(directory, source, namespace) {
  source ??= fileURLToPath(new URL('../fixtures/p1-countdown/base', import.meta.url));
  directory = resolve(directory);
  await mkdir(directory, { mode: 0o700 });
  const config = await prepareFixture({ source, output: join(directory, 'baseline'), namespace });
  const { ArtifactStore } = await import('../../src/os-artifacts.ts');
  const { preparePackage } = await import('../../src/packages.ts');
  const { nodeLuaCompiler } = await import('../../src/node-lua-compiler.ts');
  const db = new DatabaseSync(':memory:'),
    store = new ArtifactStore(db, join(directory, 'local-artifacts'));
  try {
    const files = [];
    for (const path of config.files) {
      const a = await store.stage({
        text: await readFile(join(directory, 'baseline', path), 'utf8'),
      });
      files.push({ path, artifact_id: a.id });
    }
    const p = await preparePackage(store, (x) => store.stage({ text: x }), files, 'app.json', {
      signal: AbortSignal.timeout(30000),
      compiler: nodeLuaCompiler,
    });
    for (const f of p.files)
      if (!config.files.includes(f.path))
        await copyFile(store.get(f.artifact_id).path, join(directory, 'baseline', f.path));
    const ui = JSON.parse(await readFile(join(directory, 'baseline/ui.json'), 'utf8'));
    let size;
    const walk = (n) => {
      if (n.id === 'digits') size = n.style.fontSize;
      for (const c of n.children ?? []) walk(c);
    };
    for (const n of ui.assets) walk(n);
    const lua_sha256 = {};
    for (const file of config.files.filter((p) => p.endsWith('.lua')))
      lua_sha256[file] = sha(await readFile(join(directory, 'baseline', file)));
    const state = {
      format: 'wishos-p1-cycle/1',
      phase: 'prepared',
      namespace,
      baseline: {
        ...config,
        lua_sha256,
        runtime_contract: runtimeContract(
          JSON.parse(await readFile(join(directory, 'baseline/app.json'), 'utf8')),
        ),
        inventory_sha256: sha(await readFile(join(directory, 'baseline/files.jsonl'))),
        digits_font_size: size,
      },
      receipts: {},
      owned_roots: [],
    };
    await save(join(directory, 'state.json'), state);
    const plan = {
      format: 'wishos-p1-plan/1',
      hub_url: 'http://127.0.0.1:18762',
      hub_data_dir: join(directory, 'fixture-host'),
      device_id: 'fixture-device',
      expected_mac: '02:00:00:00:00:01',
      expected_boot_id: null,
      session: {
        runtime_id: 'codex-local',
        session_id: 'fixture-session',
        session_scope: 'fixture-scope',
      },
      edit_text: '时间数字大一点，并调整排版避免裁切',
      ai_timeout_ms: 900000,
    };
    await save(join(directory, 'plan.json'), plan);
    return {
      prepared: true,
      application_id: config.application_id,
      files: p.files.map((f) => f.path),
      preflight: p.preflight,
      target_bound: false,
      device_accessed: false,
      harness_submitted: false,
    };
  } finally {
    db.close();
  }
}
