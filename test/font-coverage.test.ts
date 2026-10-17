import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preflightUi } from '../src/preflight-ui.js';
import { preflightBundle } from '../src/preflight.js';
import { ArtifactStore } from '../src/os-artifacts.js';
import type { DeviceRpc } from '../src/os-remote.js';
const caps: any = {
  format: 'brookesia-json-ui-0.1.x-subset',
  methods: 'read,capabilities,fonts,font_check',
  read_methods: 'read,capabilities,fonts,font_check',
  nodes: 'viewScreen,container,label',
  styles: 'font,fontSize',
  max_nodes: 32,
  max_depth: 8,
  max_document_bytes: 16384,
  fonts: [
    { id: 'system', scalable: true, minimum_size: 8, maximum_size: 96 },
    { id: 'reader', size: 19 },
  ],
  font_check: { method: 'font_check', max_codepoints: 2 },
};
const doc = (text: string, style: any = { fontSize: 19 }) => ({
  version: '0.1.1',
  assets: [{ type: 'viewScreen', style, children: [{ type: 'label', labelProps: { text } }] }],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wishos-font-check-')),
    db = new DatabaseSync(':memory:'),
    source = new ArtifactStore(db, root),
    calls: any[] = [];
  const state = { caps: structuredClone(caps), ioFailure: false, malformed: false };
  const rpc: DeviceRpc = async (path, method, args) => {
    calls.push({ path, method, args });
    assert.equal(args.expected_boot_id, 'boot');
    if (path === '/sys/capabilities') return { ok: true, boot_id: 'boot', result: state.caps };
    if (path === '/sys/ui' && method === 'capabilities')
      return { ok: true, boot_id: 'boot', result: state.caps };
    if (path === '/sys/ui' && method === 'fonts')
      return { ok: true, boot_id: 'boot', result: { fonts: state.caps.fonts } };
    if (path === '/sys/ui' && method === 'font_check') {
      assert(args.codepoints instanceof Array);
      assert(args.codepoints.length <= state.caps.font_check.max_codepoints);
      if (state.ioFailure)
        return { ok: false, boot_id: 'boot', error: 'font_file_unavailable', result: {} };
      return {
        ok: true,
        boot_id: 'boot',
        result: {
          missing_codepoints: state.malformed
            ? [999999]
            : (args.codepoints as number[]).filter((cp) => cp === 0x2212),
        },
      };
    }
    throw Error('unexpected non-read call ' + path + ':' + method);
  };
  return {
    state,
    calls,
    async check(page: any) {
      const asset = await source.stage({ text: JSON.stringify(page) });
      return preflightBundle(source, [{ path: 'ui.json', artifact_id: asset.id }], {
        rpc,
        expectedBoot: 'boot',
        signal: AbortSignal.timeout(3000),
      });
    },
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('advertised native coverage rejects the actual U+2212 failure before any media writes and respects the advertised batch size', async () => {
  for (const maximum of [2, 7]) {
    const f = await fixture();
    f.state.caps.font_check.max_codepoints = maximum;
    try {
      await assert.rejects(f.check(doc('−5分钟')), (e: any) =>
        e.diagnostics?.some(
          (d) => d.code === 'ui_font_missing_glyph' && d.detail.includes('U+2212'),
        ),
      );
      const checked = f.calls.filter((c) => c.method === 'font_check');
      assert(checked.length > 0);
      assert(
        checked.every(
          (c) =>
            c.args.font === 'system' && c.args.size === 19 && c.args.codepoints.length <= maximum,
        ),
      );
      assert(!f.calls.some((c) => c.path === '/fs' || c.path === '/sys/operations'));
      f.calls.length = 0;
      const repaired = await f.check(doc('-5分钟'));
      assert(repaired.ok);
      assert.deepEqual(repaired.warnings, []);
    } finally {
      await f.close();
    }
  }
});

test('coverage uses effective inherited family/size, preserves omitted system defaults and does not run future alias registration', async () => {
  const observed: any[] = [];
  const check = (page: any) =>
    preflightUi('ui.json', page, {
      capabilities: caps,
      reference: async () => {
        throw Error('unexpected reference');
      },
      document: async () => {
        throw Error('unexpected document');
      },
      fileBytes: () => undefined,
      fontCoverage: async (font, size, points) => {
        observed.push({ font, size, points });
        return [];
      },
    });
  const result = await check({
    version: '0.1.1',
    assets: [
      {
        type: 'viewScreen',
        style: { font: 'reader', fontSize: 19 },
        children: [
          { type: 'label', labelProps: { text: '正文' } },
          { type: 'label', style: { font: 'system', fontSize: 22 }, labelProps: { text: '标题' } },
          { type: 'label', style: { font: 'registered-on-start' }, labelProps: { text: '动态' } },
        ],
      },
    ],
  });
  assert.deepEqual(
    observed.map((v) => [v.font, v.size]),
    [
      ['reader', 19],
      ['system', 22],
    ],
  );
  assert(
    result.warnings.some(
      (w) => w.code === 'ui_font_coverage_deferred' && w.detail === 'registered-on-start',
    ),
  );
  observed.length = 0;
  await check(doc('默认', {}));
  assert.equal(observed[0].font, 'system');
  assert.equal(observed[0].size, undefined);
  const f = await fixture();
  try {
    await f.check(doc('默认', {}));
    assert(
      f.calls.filter((c) => c.method === 'font_check').every((c) => !Object.hasOwn(c.args, 'size')),
    );
  } finally {
    await f.close();
  }
});

test('explicit replacement policy is retained, but a strict use of the same missing glyph still fails', async () => {
  const check = (children: any[]) =>
    preflightUi(
      'ui.json',
      { version: '0.1.1', assets: [{ type: 'viewScreen', children }] },
      {
        capabilities: caps,
        reference: async () => '',
        document: async () => null,
        fileBytes: () => undefined,
        fontCoverage: async (_font, _size, points) => points.filter((cp) => cp === 0x2212),
      },
    );
  const label = { type: 'label', labelProps: { text: '−', missingGlyph: 'replace' } };
  const result = await check([label]);
  assert(result.warnings.some((w) => w.code === 'ui_font_glyph_replacement'));
  await assert.rejects(
    check([label, { type: 'label', labelProps: { text: '−' } }]),
    /ui_font_missing_glyph/,
  );
});

test('undeclared coverage remains unverified and broken declarations, I/O or invalid replies cannot become a false success', async () => {
  const f = await fixture();
  try {
    delete f.state.caps.font_check;
    const result = await f.check(doc('−5分钟'));
    assert(result.ok);
    assert(result.warnings.some((w) => w.code === 'ui_font_coverage_unverified'));
    assert(!f.calls.some((c) => c.method === 'font_check'));
    f.state.caps = structuredClone(caps);
    f.state.caps.read_methods = 'read,fonts,capabilities';
    await assert.rejects(f.check(doc('正常')), /ui_font_check_contract/);
    f.state.caps = structuredClone(caps);
    f.state.ioFailure = true;
    await assert.rejects(
      f.check(doc('正常')),
      (e: any) => e.message.includes('target_capability') && !e.message.includes('missing_glyph'),
    );
    f.state.ioFailure = false;
    f.state.malformed = true;
    await assert.rejects(f.check(doc('正常')), /ui_font_coverage_reply/);
  } finally {
    await f.close();
  }
});

test('font aliases follow renderer references and other application owners do not authorize current font coverage', async () => {
  const calls: any[] = [];
  const result = await preflightUi(
    'ui.json',
    {
      version: '0.1.1',
      assets: [
        {
          type: 'viewScreen',
          style: { fontSize: 19 },
          children: [
            { type: 'label', style: { font: '${font.reader}' }, labelProps: { text: '正文' } },
            { type: 'label', style: { font: 'private' }, labelProps: { text: '下一实例再注册' } },
            {
              type: 'label',
              style: { font: '/fonts/existing.ttf' },
              labelProps: { text: '文件字体' },
            },
          ],
        },
      ],
    },
    {
      capabilities: { ...caps, fonts: [...caps.fonts, { id: 'private', owner: 31, size: 19 }] },
      reference: async () => '',
      document: async () => null,
      fileBytes: () => undefined,
      fontCoverage: async (font, size, points) => {
        calls.push({ font, size, points });
        return [];
      },
    },
  );
  assert.deepEqual(
    calls.map((c) => c.font),
    ['reader', '/fonts/existing.ttf'],
  );
  assert(
    result.warnings.some((w) => w.code === 'ui_font_coverage_deferred' && w.detail === 'private'),
  );
});
