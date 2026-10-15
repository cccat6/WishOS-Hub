import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { ArtifactStore } from '../src/os-artifacts.js';
import { nodeLuaCompiler } from '../src/node-lua-compiler.js';
import { preflightBundle, PreflightError } from '../src/preflight.js';
import { preparePackage } from '../src/packages.js';
import { guardedInvocation } from '../src/preflight-call.js';
import { managedAgentRoute } from '../src/os-agent.js';
import { createWishosMcp } from '../src/wishos-mcp.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { DeviceRpc } from '../src/os-remote.js';
const signal = () => AbortSignal.timeout(10000);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wishos-preflight-')),
    db = new DatabaseSync(':memory:'),
    source = new ArtifactStore(db, root);
  return {
    root,
    source,
    close: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const runtime = {
  engine: 'lua-5.4.8',
  methods: 'read,load,restart,validate',
  read_methods: 'read',
  entry_source_limit_bytes: 4096,
  budgets: {
    memory_bytes: { minimum: 16384, maximum: 240000 },
    instruction_budget: { minimum: 1000, maximum: 200000 },
    system_call_budget: { minimum: 1, maximum: 256 },
  },
};
function device() {
  const calls: any[] = [];
  const rpc: DeviceRpc = async (path, method, args) => {
    calls.push({ path, method, args });
    return {
      ok: true,
      boot_id: 'boot',
      result:
        path === '/sys/capabilities'
          ? args.path === '/sys/runtime'
            ? runtime
            : args.path === '/sys/apps'
              ? {
                  methods: 'read,validate,validation,release_validation,install,launch',
                  read_methods: 'read,validation',
                  manifest_limit_bytes: 512,
                  package_validation: {
                    file_kinds: 'lua,json,asset',
                    header_limit_bytes: 512,
                    inventory_line_limit_bytes: 512,
                    json_limit_bytes: 16384,
                    lua_source_limit_bytes: 4096,
                  },
                  package_install: { validation_required: true },
                }
              : { methods: 'read', read_methods: 'read' }
          : path === '/sys/runtime'
            ? {
                source_limit_bytes: 4096,
                memory_policy_limit_bytes: 240000,
                default_vm_memory_bytes: 65536,
              }
            : path === '/sys/board'
              ? {}
              : {},
    };
  };
  return { calls, rpc };
}
async function stage(source: ArtifactStore, path: string, text: string) {
  return { path, artifact_id: (await source.stage({ text })).id };
}
async function packageFiles(
  source: ArtifactStore,
  lua = 'return {on_start=function() end}',
  extra: Record<string, unknown> = {},
) {
  return preparePackage(
    source,
    (text, s) => source.stage({ text }, s),
    [
      await stage(
        source,
        'app.json',
        JSON.stringify({
          format: 'wishos-app/1',
          id: 'sample',
          title: 'Sample',
          entry: 'main.lua',
          ...extra,
        }),
      ),
      await stage(source, 'main.lua', lua),
    ],
    'app.json',
    { compiler: nodeLuaCompiler, signal: signal() },
  );
}
test('stock Lua 5.4.8 parser accepts language features, rejects syntax/scope/NUL, and never executes chunks', async () => {
  const compiler = await nodeLuaCompiler();
  for (const source of [
    'local x <const> = 1; return x',
    'local f <close> = nil; return 1',
    'while true do end',
    'error("must not run")',
    'local x="中文"; return x',
  ])
    assert.equal(compiler.check(source, 'test.lua').ok, true, source);
  for (const source of ['local = 1', 'local x <const> = 1; x=2', 'goto missing', 'local a="\0"'])
    assert.equal(compiler.check(source, 'test.lua').ok, false, source);
  assert.equal(compiler.check('return 1', 'bad\0.lua').ok, false);
  const cli = spawnSync(process.execPath, ['scripts/check-lua.mjs'], {
    input: JSON.stringify({
      files: [
        { path: 'valid.lua', source: 'while true do end' },
        { path: 'bad.lua', source: 'function (' },
      ],
    }),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.parser.version, '5.4.8');
  assert(result.files[1].error.includes('bad.lua'));
});
test('complete package preflight uses target maximum rather than default VM limit; reads are side-effect free', async () => {
  const f = await fixture(),
    d = device();
  try {
    const prepared = await packageFiles(f.source, 'return {}', { memory_bytes: 120000 });
    const report = await preflightBundle(f.source, prepared.files, {
      compiler: nodeLuaCompiler,
      rpc: d.rpc,
      expectedBoot: 'boot',
      signal: signal(),
    });
    assert.equal(report.packages[0].id, 'sample');
    assert.equal(report.lua.files, 1);
    assert(d.calls.every((c) => ['describe', 'read'].includes(c.method)));
    assert.equal(report.target_boot_id, 'boot');
    await assert.rejects(
      packageFiles(f.source, 'return {}', { memory_bytes: 300000 }).then((p) =>
        preflightBundle(f.source, p.files, {
          compiler: nodeLuaCompiler,
          rpc: d.rpc,
          expectedBoot: 'boot',
          signal: signal(),
        }),
      ),
      /application_budget/,
    );
  } finally {
    await f.close();
  }
});
test('invalid syntax, missing references and source mutation reject before delivery or storage preparation', async () => {
  const f = await fixture(),
    d = device();
  try {
    const bad = await stage(f.source, 'bad.lua', 'return {');
    await assert.rejects(f.source.deliver(d.rpc, [bad], signal(), 'boot'), /lua_syntax/);
    assert.equal(d.calls.length, 0);
    const missing = await stage(
      f.source,
      'missing.lua',
      'local x=notes.require("not-there.lua");return x',
    );
    await assert.rejects(f.source.deliver(d.rpc, [missing], signal(), 'boot'), /reference_missing/);
    assert(d.calls.every((c) => ['describe', 'read'].includes(c.method)));
    const good = await stage(f.source, 'safe.txt', 'AAAA');
    await writeFile(f.source.get(good.artifact_id).path, 'BBBB');
    await assert.rejects(f.source.deliver(d.rpc, [good], signal(), 'boot'), /source_digest/);
    assert(
      !d.calls.some((c) =>
        ['mounts', 'begin', 'file', 'chunk', 'commit', 'configure'].includes(c.method),
      ),
    );
  } finally {
    await f.close();
  }
});
test('inventory detects omissions, sorting, digest and package-escaping references; parent-relative internal modules work', async () => {
  const f = await fixture();
  try {
    const prepared = await packageFiles(f.source);
    await assert.rejects(
      preflightBundle(
        f.source,
        prepared.files.filter((f) => f.path !== 'main.lua'),
        { compiler: nodeLuaCompiler, signal: signal() },
      ),
      /reference_missing|inventory_file_identity/,
    );
    const inv = await stage(f.source, 'files.jsonl', '{}\n');
    await assert.rejects(
      preflightBundle(
        f.source,
        prepared.files.map((file) => (file.path === 'files.jsonl' ? inv : file)),
        { compiler: nodeLuaCompiler, signal: signal() },
      ),
      /inventory_digest/,
    );
    const files = [
      await stage(
        f.source,
        'apps/app.json',
        JSON.stringify({
          format: 'wishos-app/1',
          id: 'parent',
          title: 'Parent',
          entry: '../main.lua',
        }),
      ),
      await stage(f.source, 'main.lua', 'local m=notes.require("./lib.lua");return m'),
      await stage(f.source, 'lib.lua', 'return {}'),
    ];
    const p = await preparePackage(
      f.source,
      (text, s) => f.source.stage({ text }, s),
      files,
      'apps/app.json',
      { compiler: nodeLuaCompiler, signal: signal() },
    );
    assert.equal(p.preflight.packages[0].manifest, 'apps/app.json');
    await assert.rejects(
      preflightBundle(
        f.source,
        [await stage(f.source, 'a', 'x'), await stage(f.source, 'a/b', 'y')],
        { compiler: nodeLuaCompiler, signal: signal() },
      ),
      /file_list/,
    );
  } finally {
    await f.close();
  }
});
test('generic runtime and tracked calls use real parser and retain known not-dispatched rejection', async () => {
  const d = device();
  const bad = await guardedInvocation(
    d.rpc,
    nodeLuaCompiler,
    '/sys/operations',
    'request',
    {
      path: '/sys/runtime',
      method: 'load',
      args: { source: 'local = 1' },
      expected_boot_id: 'boot',
    },
    signal(),
    'boot',
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.result.not_dispatched, true);
  assert(!d.calls.some((c) => c.method === 'load' || c.method === 'request'));
  const good = await guardedInvocation(
    d.rpc,
    nodeLuaCompiler,
    '/sys/runtime',
    'load',
    { source: 'while true do end', memory_bytes: 120000, expected_boot_id: 'boot' },
    signal(),
    'boot',
  );
  assert.equal(good.ok, true);
  assert.equal(d.calls.filter((c) => c.method === 'load').length, 1);
  const install = await guardedInvocation(
    d.rpc,
    nodeLuaCompiler,
    '/sys/apps',
    'install',
    { manifest: '/card/app.json', expected_boot_id: 'boot' },
    signal(),
    'boot',
  );
  assert.equal(install.ok, false);
  assert(!d.calls.some((c) => c.method === 'install'));
});
test('managed inline and JSONL source actions are checked before any transfer and action order is preserved', async () => {
  const f = await fixture(),
    d = device();
  const rpc: DeviceRpc = async (p, m, a) =>
    p === '/sys/capabilities' && a.path === '/services/ai'
      ? {
          ok: true,
          boot_id: 'boot',
          result: {
            result_format: 'wishos-result/2',
            action_limit_bytes: 2048,
            inline_result_limit_bytes: 1536,
          },
        }
      : d.rpc(p, m, a);
  try {
    for (const mode of ['inline', 'jsonl']) {
      const actions = [
        { type: 'application', data: { text: 'before' } },
        { type: 'system', path: '/sys/runtime', method: 'load', args: { source: 'local = 1' } },
        { type: 'application', data: { text: 'after' } },
      ];
      const line = await stage(
        f.source,
        'actions.jsonl',
        actions.map((a) => JSON.stringify(a)).join('\n'),
      );
      const envelope =
        mode === 'inline'
          ? { format: 'wishos-result/2', actions }
          : {
              format: 'wishos-result/2',
              sequence: { path: 'actions.jsonl', format: 'jsonl' },
              files: [line],
            };
      const route = managedAgentRoute({
        rpc,
        artifacts: f.source,
        start: () => ({ id: mode }),
        status: () => ({ status: 'completed', result: JSON.stringify(envelope) }),
      });
      await assert.rejects(
        route(
          {
            id: 1,
            request_id: mode,
            boot_id: 'boot',
            route: 'wishos.ai',
            payload: { format: 'wishos-ai/2', input: { text: 'task' } },
          },
          signal(),
        ),
        /lua_syntax/,
      );
    }
    assert(!d.calls.some((c) => ['load', 'begin', 'mounts', 'chunk'].includes(c.method)));
  } finally {
    await f.close();
  }
});
test('MCP clients discover layer guidance, authoritative references, authoring prompt and package tools', async () => {
  const server = createWishosMcp(async () => ({ content: [{ type: 'text', text: '{}' }] })),
    client = new Client({ name: 'preflight-fixture', version: '1' });
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(transport), client.connect(peer)]);
    const resources = await client.listResources();
    assert(resources.resources.some((r) => r.uri === 'wishos://guidance/components'));
    const index = await client.readResource({ uri: 'wishos://guidance/components' });
    const catalog = JSON.parse((index.contents[0] as any).text);
    assert.deepEqual(
      catalog.components.map((c: any) => c.layer),
      ['overview', 'system', 'drivers', 'applications', 'packages'],
    );
    assert(catalog.references.some((r: any) => r.id === 'packages'));
    const guide: any = await client.callTool({
      name: 'get_guidance',
      arguments: { component_id: 'wishos-packages' },
    });
    assert(!guide.isError);
    assert(guide.content[0].resource.text.includes('whole'));
    assert((await client.listPrompts()).prompts.some((p) => p.name === 'wishos-authoring'));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of [
      'preflight_bundle',
      'prepare_package',
      'deploy_package',
      'update_package',
      'get_device_components',
    ])
      assert(tools.includes(tool));
  } finally {
    await client.close();
    await server.close();
  }
});

test('package deployment commits only validated revisions; failure releases ticket and preserves the running app', async () => {
  const f = await fixture();
  const { PackageDevice } = await import('./fixtures/package-device.js');
  const { deployPackage } = await import('../src/packages.js');
  const d = new PackageDevice();
  try {
    const p = await packageFiles(f.source);
    const result = await deployPackage(f.source, p.files, d.rpc, d.boot, {
      compiler: nodeLuaCompiler,
      signal: signal(),
      activate: true,
    });
    assert.equal(result.state, 'activated');
    assert.equal(d.active, 'sample');
    assert.equal(d.ticket, undefined);
    const original = d.installed!.package,
      revision = d.revision;
    d.failValidation = true;
    await assert.rejects(
      deployPackage(f.source, p.files, d.rpc, d.boot, {
        compiler: nodeLuaCompiler,
        signal: signal(),
      }),
      /native_package_validation/,
    );
    assert.equal(d.installed!.package, original);
    assert.equal(d.revision, revision);
    assert.equal(d.active, 'sample');
    assert.equal(d.ticket, undefined);
    assert.equal(d.released, 1);
  } finally {
    await f.close();
  }
});
test('whole-file update parses complete control sources but does not download unchanged binary assets', async () => {
  const f = await fixture();
  const { PackageDevice } = await import('./fixtures/package-device.js');
  const { deployPackage, prepareUpdate } = await import('../src/packages.js');
  const d = new PackageDevice();
  try {
    const binary = await f.source.stageStream(
      (async function* () {
        yield Buffer.alloc(4096, 93);
      })(),
    );
    const prepared = await preparePackage(
      f.source,
      (text, s) => f.source.stage({ text }, s),
      [
        await stage(
          f.source,
          'app.json',
          JSON.stringify({
            format: 'wishos-app/1',
            id: 'sample',
            title: 'Sample',
            entry: 'main.lua',
          }),
        ),
        await stage(f.source, 'main.lua', 'return {version=1}'),
        { path: 'image.bin', artifact_id: binary.id },
        await stage(f.source, 'obsolete.txt', 'old'),
      ],
      'app.json',
      { compiler: nodeLuaCompiler, signal: signal() },
    );
    await deployPackage(f.source, prepared.files, d.rpc, d.boot, {
      compiler: nodeLuaCompiler,
      signal: signal(),
    });
    const oldRoot = '/card/revisions/1',
      replacement = await stage(f.source, 'main.lua', 'return {version=2}');
    d.reads.clear();
    const uploaded = d.uploaded;
    const update = await prepareUpdate(
      f.source,
      (text, s) => f.source.stage({ text }, s),
      d.rpc,
      d.boot,
      {
        application_id: 'sample',
        expected_revision: 1,
        replacements: [replacement],
        delete: ['obsolete.txt'],
      },
      { compiler: nodeLuaCompiler, signal: signal() },
    );
    assert.equal(d.reads.get(oldRoot + '/image.bin'), undefined);
    assert(d.reads.get(oldRoot + '/app.json')! > 0);
    assert(update.preflight.warnings.some((w) => w.code === 'native_copy_digest_required'));
    await deployPackage(update.source, update.files, d.rpc, d.boot, {
      compiler: nodeLuaCompiler,
      signal: signal(),
      expected_revision: 1,
    });
    assert.equal(d.revision, 2);
    assert.equal(d.reads.get(oldRoot + '/image.bin'), undefined);
    assert(d.copied >= 4096);
    assert(d.uploaded - uploaded < 4096);
    assert(!d.files.has('/card/revisions/2/obsolete.txt'));
    assert.equal(d.files.get(oldRoot + '/main.lua')!.toString(), 'return {version=1}');
    assert.equal(d.files.get('/card/revisions/2/main.lua')!.toString(), 'return {version=2}');
    const calls = d.calls.length;
    await assert.rejects(
      prepareUpdate(
        f.source,
        (text, s) => f.source.stage({ text }, s),
        d.rpc,
        d.boot,
        { application_id: 'sample', expected_revision: 1, replacements: [replacement] },
        { compiler: nodeLuaCompiler, signal: signal() },
      ),
      /base_revision_changed/,
    );
    assert(!d.calls.slice(calls).some((c) => c.method === 'begin'));
  } finally {
    await f.close();
  }
});

test('UI structure preflight follows external view/image paths and accepts future runtime font bindings', async () => {
  const f = await fixture();
  try {
    const files = [
      await stage(
        f.source,
        'page.json',
        JSON.stringify({ version: '0.1.1', assets: ['assets/screen.json'] }),
      ),
      await stage(
        f.source,
        'assets/screen.json',
        JSON.stringify({
          type: 'viewScreen',
          layout: { type: 'flex', flexFlow: 'column' },
          children: [
            {
              type: 'label',
              style: { font: '${font.custom}', fontSize: 22 },
              labelProps: { text: 'font registered on_start', missingGlyph: 'replace' },
            },
            { type: 'image', imageProps: { src: 'icon.bin' } },
          ],
        }),
      ),
      await stage(f.source, 'assets/icon.bin', 'image-bytes'),
    ];
    const d = device();
    const rpc: DeviceRpc = async (path, method, args) =>
      (path === '/sys/capabilities' && args.path === '/sys/ui') || path === '/sys/ui'
        ? {
            ok: true,
            boot_id: 'boot',
            result: {
              format: 'brookesia-json-ui-0.1.x-subset',
              nodes: 'viewScreen,container,label,button,image',
              max_nodes: 32,
              max_document_bytes: 16384,
            },
          }
        : d.rpc(path, method, args);
    const result = await preflightBundle(f.source, files, {
      compiler: nodeLuaCompiler,
      rpc,
      expectedBoot: 'boot',
      signal: signal(),
    });
    assert(result.ok);
    assert.equal(result.warnings.length, 0);
    const invalid = await stage(
      f.source,
      'assets/screen.json',
      JSON.stringify({ type: 'viewScreen', style: { boxShadow: '1px' }, children: [] }),
    );
    await assert.rejects(
      preflightBundle(
        f.source,
        files.map((f) => (f.path === invalid.path ? invalid : f)),
        { compiler: nodeLuaCompiler, rpc, expectedBoot: 'boot', signal: signal() },
      ),
      /ui_style_not_supported/,
    );
    await assert.rejects(
      preflightBundle(
        f.source,
        files.filter((f) => f.path !== 'assets/icon.bin'),
        { compiler: nodeLuaCompiler, rpc, expectedBoot: 'boot', signal: signal() },
      ),
      /reference_missing/,
    );
  } finally {
    await f.close();
  }
});

test('parser profile matches embedded nesting and rejects a mismatched declared target', async () => {
  const compiler = await nodeLuaCompiler();
  assert.equal(compiler.profile.native_call_depth_limit, 32);
  assert.equal(
    compiler.check('local n = ' + '('.repeat(40) + '1' + ')'.repeat(40), 'nested.lua').ok,
    false,
  );
  const f = await fixture();
  try {
    const file = await stage(f.source, 'main.lua', 'return {}');
    const d = device(),
      rpc: DeviceRpc = async (path, method, args) => {
        const reply = await d.rpc(path, method, args);
        if (path === '/sys/runtime') reply.result.native_call_depth_limit = 200;
        return reply;
      };
    await assert.rejects(
      preflightBundle(f.source, [file], {
        compiler: nodeLuaCompiler,
        rpc,
        expectedBoot: 'boot',
        signal: signal(),
      }),
      /lua_parser_profile_mismatch/,
    );
  } finally {
    await f.close();
  }
});
test('large JSON data assets remain streamed and optional inventory kinds survive whole-file package preparation', async () => {
  const f = await fixture();
  try {
    const bytes = 'not parsed as control '.repeat(60000),
      asset = await stage(f.source, 'records.json', bytes);
    const plain = await preflightBundle(f.source, [asset], {
      compiler: nodeLuaCompiler,
      signal: signal(),
    });
    assert.equal(plain.lua.files, 0);
    const files = [
      await stage(
        f.source,
        'app.json',
        JSON.stringify({ format: 'wishos-app/1', id: 'data', title: 'Data', entry: 'main.lua' }),
      ),
      await stage(f.source, 'main.lua', 'return {}'),
      { ...asset, kind: 'asset' as const },
    ];
    const prepared = await preparePackage(
      f.source,
      (text, s) => f.source.stage({ text }, s),
      files,
      'app.json',
      { compiler: nodeLuaCompiler, signal: signal() },
    );
    assert.equal(prepared.preflight.packages.length, 1);
    const inventory = prepared.files.find((f) => f.path === 'files.jsonl')!;
    assert(
      (await readFile(f.source.get(inventory.artifact_id).path, 'utf8')).includes('"kind":"asset"'),
    );
    await assert.rejects(
      preflightBundle(f.source, [{ ...asset, kind: 'json' }], {
        compiler: nodeLuaCompiler,
        signal: signal(),
      }),
      /host_text_budget/,
    );
    await assert.rejects(
      preflightBundle(
        f.source,
        [{ ...(await stage(f.source, 'bad.lua', 'local = 1')), kind: 'asset' }],
        { compiler: nodeLuaCompiler, signal: signal() },
      ),
      /lua_syntax/,
    );
  } finally {
    await f.close();
  }
});

test('an installed revision survives activation refusal with receipts, while old foreground remains', async () => {
  const f = await fixture();
  const { PackageDevice } = await import('./fixtures/package-device.js'),
    { deployPackage } = await import('../src/packages.js');
  const d = new PackageDevice();
  try {
    const p = await packageFiles(f.source);
    d.failActivation = true;
    let rejected: any;
    try {
      await deployPackage(f.source, p.files, d.rpc, d.boot, {
        compiler: nodeLuaCompiler,
        signal: signal(),
        activate: true,
      });
    } catch (error) {
      rejected = error;
    }
    assert(rejected);
    assert.equal(d.revision, 1);
    assert.equal(d.active, 'original');
    assert.equal(rejected.receipts.install.revision, 1);
    assert(rejected.receipts.transfer.root);
    assert.equal(rejected.receipts.activation_admission.ok, false);
    assert.equal(
      d.calls.filter((c) => c.path === '/sys/operations' && c.method === 'request').length,
      1,
    );
    assert(d.files.has('/card/revisions/1/main.lua'));
    assert.equal(d.ticket, undefined);
  } finally {
    await f.close();
  }
});
