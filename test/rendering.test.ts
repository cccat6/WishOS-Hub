import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { crc32, validRaster, Raster } from '../src/raster.js';
import { imageRaster, svgScene } from '../src/rendering.js';
test('NMR1 matches independent Python fixture; CRC, pixel count and palette failures reject', async () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const frame = await readFile(new URL('./fixtures/two-tone.nmr', import.meta.url));
  assert.ok(validRaster(frame.toString('base64')));
  const corrupt = Buffer.from(frame);
  corrupt[15] ^= 1;
  assert.equal(validRaster(corrupt.toString('base64')), false);
  for (const [offset, value] of [
    [12, 0],
    [14, 4],
  ] as const) {
    const b = Buffer.from(frame);
    if (offset === 12) b.writeUInt16LE(value, offset);
    else b[offset] = value;
    b.writeUInt32LE(crc32(b.subarray(12)), 8);
    assert.equal(validRaster(b.toString('base64')), false);
  }
  const truncated = frame.subarray(0, frame.length - 3);
  truncated.writeUInt32LE(crc32(truncated.subarray(12)), 8);
  assert.equal(validRaster(truncated.toString('base64')), false);
  assert.equal(Raster.safeParse('!not-base64').success, false);
  assert.equal(Raster.safeParse('A'.repeat(8004)).success, false);
});
test('host SVG converts known subset; transforms and external entities fail instead of disappearing', async () => {
  const s = await svgScene(
    '<svg viewBox="0 0 480 720"><rect x="10" y="20" width="100" height="80" fill="red"/></svg>',
  );
  assert.deepEqual(s.commands, [{ op: 'fill', x: 10, y: 20, w: 100, h: 80, color: 3 }]);
  await assert.rejects(svgScene('<svg viewBox="0 0 480 720"><path d="M0 0 L20 20"/></svg>'));
  await assert.rejects(
    svgScene(
      '<!DOCTYPE svg [<!ENTITY e SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 480 720"/>',
    ),
  );
});
test('PNG/JPEG raster bridge has a bounded six-color representation and reports reduction metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notes-raster-test-'));
  const chunk = (name: string, data: Buffer) => {
    const b = Buffer.alloc(data.length + 12);
    b.writeUInt32BE(data.length);
    b.write(name, 4);
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, b.length - 4)), b.length - 4);
    return b;
  };
  try {
    const h = Buffer.alloc(13);
    h.writeUInt32BE(1, 0);
    h.writeUInt32BE(1, 4);
    h[8] = 8;
    h[9] = 2;
    const png = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', h),
      chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const path = join(dir, 'white.png');
    await writeFile(path, png);
    const result = await imageRaster(path);
    assert.equal(result.rendering.detail_reduction_factor, 1);
    assert.ok(result.rendering.bytes <= 6000);
    assert.ok(validRaster(result.data));
    const jpeg = join(dir, 'white.jpg');
    const python =
      process.env.NOTES_RENDER_PYTHON ??
      fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
    execFileSync(
      python,
      [
        '-c',
        'from PIL import Image; import sys; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2],"JPEG")',
        path,
        jpeg,
      ],
      { env: { PATH: process.env.PATH ?? '' } },
    );
    const fromJpeg = await imageRaster(jpeg);
    assert.ok(validRaster(fromJpeg.data));
    assert.equal(fromJpeg.rendering.detail_reduction_factor, 1);
    await assert.rejects(imageRaster(join(dir, 'secrets.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('native SVG preserves typography, paths/transforms and pixel resolution; external resources reject', async () => {
  const { svgRaster } = await import('../src/rendering.js');
  const svg =
    '<svg viewBox="0 0 480 720"><rect width="480" height="720" fill="white"/><g transform="translate(32 40)"><path d="M0 30 Q80 0 160 30" stroke="black" fill="none"/><text x="0" y="100" font-family="sans-serif" font-size="32">清晰中文 Agentic Notes</text></g></svg>';
  const result = await svgRaster(svg);
  assert.equal(result.rendering.format, 'nmp1');
  assert.equal(result.rendering.detail_reduction_factor, 1);
  assert.equal(result.rendering.native_resolution, true);
  assert.deepEqual(result.rendering.logical_detail, [480, 720]);
  assert.ok(validRaster(result.data));
  for (const attack of [
    '<image href="file:///etc/passwd"/>',
    '<image href="https://example.com/image.png"/>',
    '<style>@import url("http://example.com/font");</style>',
    '<script>alert(1)</script>',
  ])
    await assert.rejects(svgRaster('<svg viewBox="0 0 480 720">' + attack + '</svg>'));
});
test('host color modes and protected text are explicit and do not change firmware payload format', async () => {
  const { svgRaster } = await import('../src/rendering.js');
  const source =
    '<svg viewBox="0 0 480 720"><defs><linearGradient id="g"><stop stop-color="#b16cab"/><stop offset="1" stop-color="white"/></linearGradient></defs><rect x="24" y="20" width="64" height="64" fill="url(#g)"/><text x="24" y="140" font-family="sans-serif" font-size="32">电子纸清晰文字</text></svg>';
  for (const color_mode of ['nearest', 'dither', 'ordered', 'blue-noise', 'adaptive'] as const) {
    const result = await svgRaster(source, { color_mode });
    assert.ok(validRaster(result.data));
    assert.equal(result.rendering.color_mode, color_mode);
    assert.equal(result.rendering.text_protected, true);
    assert.equal(result.rendering.text_dithered, false);
    assert.equal(result.rendering.text_sampling, 'native');
    assert.equal(result.rendering.text_threshold, null);
    assert.equal(result.rendering.text_raster, 'stems');
    if (color_mode === 'adaptive') {
      assert.equal(result.rendering.sampling_optimization?.algorithm, 'six-ink-local-swap');
      assert.equal(result.rendering.sampling_optimization?.ink_counts_preserved, true);
    }
    assert.ok(result.rendering.protected_glyph_pixels > 0);
    assert.equal(result.rendering.detail_reduction_factor, 1);
  }
  await assert.rejects(
    svgRaster('<svg viewBox="0 0 480 720"><rect width="480" height="720" fill="#aabbcc"/></svg>', {
      color_mode: 'strict',
      invalid_color: 'error',
    }),
    /Strict six-color/,
  );
  const strict = await svgRaster(
    '<svg viewBox="0 0 480 720"><rect width="480" height="720" fill="#aabbcc"/></svg>',
    { color_mode: 'strict', invalid_color: 1 },
  );
  assert.ok(validRaster(strict.data));
  assert.equal(strict.rendering.color_mode, 'strict');
});

test('exact input is independent from conversion modes and text threshold is bounded', async () => {
  const { svgRaster } = await import('../src/rendering.js');
  const { RenderOptions } = await import('../src/render-options.js');
  const result = await svgRaster(
    '<svg viewBox="0 0 480 720"><rect width="480" height="720" fill="#123456"/></svg>',
    { input_rule: 'exact' },
  );
  assert.equal(result.rendering.input_rule, 'exact');
  assert.equal(result.rendering.strict_invalid_color, 0);
  assert.equal(result.rendering.replaced_pixels, 480 * 720);
  for (const options of [
    { input_rule: 'exact', color_mode: 'dither' },
    { input_rule: 'convert', color_mode: 'strict' },
    { input_rule: 'exact', text_threshold: 120 },
    { text_threshold: 63 },
    { text_threshold: 193 },
  ])
    assert.equal(RenderOptions.safeParse(options).success, false);
  const text =
    '<svg viewBox="0 0 480 720"><text x="24" y="80" font-size="32">清晰文字 Aa 123</text></svg>';
  const finer = await svgRaster(text, { text_threshold: 120 });
  const coverage = await svgRaster(text, { text_sampling: 'coverage' });
  assert.equal(finer.rendering.text_threshold, 120);
  assert.equal(coverage.rendering.text_threshold, 128);
  assert.ok(validRaster(finer.data));
  assert.ok(validRaster(coverage.data));
});

test('high-resolution text coverage retains native pixels and chosen threshold', async () => {
  const { svgRaster } = await import('../src/rendering.js');
  const { RenderOptions } = await import('../src/render-options.js');
  const source =
    '<svg viewBox="0 0 480 720"><text x="32" y="80" font-size="32">清晰 木日 Aa 123</text></svg>';
  const result = await svgRaster(source, { text_sampling: 'coverage', text_scale: 8 });
  assert.ok(validRaster(result.data));
  assert.equal(result.rendering.text_scale, 8);
  assert.equal(result.rendering.text_threshold, 128);
  assert.equal(result.rendering.text_dithered, false);
  assert.deepEqual(result.rendering.logical_detail, [480, 720]);
  assert.equal(RenderOptions.safeParse({ text_scale: 8 }).success, false);
  assert.equal(
    RenderOptions.safeParse({ text_sampling: 'coverage', text_scale: 32 }).success,
    false,
  );
});

test('square text is host-only and explicit; native frame and area metadata remain valid', async () => {
  const { svgRaster } = await import('../src/rendering.js');
  const { RenderOptions } = await import('../src/render-options.js');
  const source =
    '<svg viewBox="0 0 480 720"><text x="32" y="80" font-size="32">清晰 木日 Aa 123</text></svg>';
  for (const strength of ['balanced', 'crisp'] as const) {
    const result = await svgRaster(source, {
      text_sampling: 'coverage',
      text_scale: 8,
      text_raster: 'square',
      text_square_strength: strength,
    });
    assert.ok(validRaster(result.data));
    assert.equal(result.rendering.text_raster, 'square');
    assert.equal(result.rendering.square_text?.strength, strength);
    assert.ok(
      Number(result.rendering.square_text?.energy_after) <=
        Number(result.rendering.square_text?.energy_before),
    );
    assert.deepEqual(result.rendering.logical_detail, [480, 720]);
  }
  for (const bad of [
    { text_raster: 'square' },
    { text_raster: 'square', text_sampling: 'coverage', edge_mode: 'source' },
    { text_square_strength: 'crisp' },
    { input_rule: 'exact', text_raster: 'square', text_sampling: 'coverage' },
  ])
    assert.equal(RenderOptions.safeParse(bad).success, false);
});

test('native monochrome text and selectable SVG font families are host-only', async () => {
  const { textRaster, svgRaster, NativeTextLayout } = await import('../src/rendering.js');
  for (const font_family of ['noto', 'sarasa', 'plex'] as const) {
    const text = await textRaster({
      blocks: [{ x: 24, y: 24, w: 432, h: 160, text: '清晰文字 Aa 123', font_family }],
    });
    assert.ok(validRaster(text.data));
    assert.equal(text.rendering.renderer, 'freetype-mono');
    assert.deepEqual(text.rendering.font_families, [font_family]);
    assert.equal(text.rendering.native_resolution, true);
    const svg = await svgRaster(
      '<svg viewBox="0 0 480 720"><text x="24" y="80" font-size="32">清晰文字 Aa 123</text></svg>',
      { font_family },
    );
    assert.ok(validRaster(svg.data));
    assert.equal(svg.rendering.font_family, font_family);
  }
  assert.equal(
    NativeTextLayout.safeParse({
      blocks: [{ x: 0, y: 0, w: 480, h: 720, text: 'hi', font_family: 'arbitrary' }],
    }).success,
    false,
  );
  await assert.rejects(
    textRaster({ blocks: [{ x: 0, y: 0, w: 20, h: 20, text: 'too big', font_size: 40 }] }),
  );
});

test('automatic CJK grid hinting is explicit and preserves native frame limits', async () => {
  const { textRaster } = await import('../src/rendering.js');
  const result = await textRaster({
    blocks: [{ x: 24, y: 24, w: 432, h: 180, text: '清晰文字 Aa 123', hinting: 'auto' }],
  });
  assert.ok(validRaster(result.data));
  assert.deepEqual(result.rendering.hinting_modes, ['auto']);
  assert.equal(result.rendering.native_resolution, true);
});

test('native text can explicitly select a stable font baseline', async () => {
  const { textRaster, NativeTextLayout } = await import('../src/rendering.js');
  const result = await textRaster({
    blocks: [
      {
        x: 24,
        y: 24,
        w: 432,
        h: 180,
        text: 'Aa\n清晰文字',
        hinting: 'auto',
        baseline_mode: 'font',
      },
    ],
  });
  assert.ok(validRaster(result.data));
  assert.deepEqual(result.rendering.baseline_modes, ['font']);
  assert.equal(
    NativeTextLayout.safeParse({
      blocks: [{ x: 0, y: 0, w: 480, h: 720, text: 'hi', baseline_mode: 'bogus' }],
    }).success,
    false,
  );
});

test('experimental outline stem alignment renders a bounded native raster', async () => {
  const { textRaster } = await import('../src/rendering.js');
  const result = await textRaster({
    blocks: [
      {
        x: 24,
        y: 24,
        w: 432,
        h: 160,
        text: '清晰 木日 Aa 123',
        hinting: 'stems',
        baseline_mode: 'font',
      },
    ],
  });
  assert.ok(validRaster(result.data));
  assert.deepEqual(result.rendering.hinting_modes, ['stems']);
  assert.equal(result.rendering.outline_grid[0].model, 'outline-stem-alignment');
  assert.ok(result.rendering.outline_grid[0].glyphs_changed > 0);
});

test('SVG J text preserves overdraw and strict unsupported typography is explicit', async () => {
  const { svgRaster } = await import('../src/rendering.js');
  const source =
    '<svg viewBox="0 0 480 720"><text x="24" y="80" font-size="32">清晰文字</text><rect x="0" y="0" width="480" height="140" fill="white"/></svg>';
  const covered = await svgRaster(source);
  const blank = await svgRaster('<svg viewBox="0 0 480 720"/>');
  assert.equal(covered.data, blank.data);
  assert.equal(covered.rendering.protected_glyph_pixels, 0);
  const tilted =
    '<svg viewBox="0 0 480 720"><text x="24" y="80" font-size="32" transform="rotate(5)">清晰文字</text></svg>';
  await assert.rejects(svgRaster(tilted), /vector mode/);
  const compatible = await svgRaster(tilted, { svg_text_mode: 'vector' });
  assert.ok(validRaster(compatible.data));
  const explicitFallback = await svgRaster(tilted, { strict_text: false });
  assert.equal(explicitFallback.rendering.vector_fallbacks.length, 1);
  const family =
    '<svg viewBox="0 0 480 720"><text x="24" y="80" font-size="32">清晰文字</text></svg>';
  const svg = await svgRaster(family, { color_mode: 'dither' });
  assert.equal(svg.rendering.text_dithered, false);
  assert.ok(svg.rendering.protected_glyph_pixels > 0);
});

test('landscape native text and SVG retain native pixels in portrait storage', async () => {
  const { textRaster, svgRaster } = await import('../src/rendering.js');
  const native = await textRaster({
    orientation: 'landscape',
    blocks: [{ x: 260, y: 160, w: 400, h: 160, text: '横屏内容 清晰文字', font_size: 32 }],
  });
  assert.ok(validRaster(native.data));
  assert.deepEqual(native.rendering.layout_size, [720, 480]);
  assert.deepEqual(native.rendering.storage_size, [480, 720]);
  const svg = await svgRaster(
    '<svg viewBox="0 0 720 480"><text x="260" y="160" font-size="32">横屏内容</text></svg>',
    { orientation: 'landscape' },
  );
  assert.ok(validRaster(svg.data));
  assert.deepEqual(svg.rendering.logical_detail, [720, 480]);
  assert.ok(svg.rendering.grid_text_elements > 0);
});

test('one-pixel SVG axis strokes survive native palette conversion', async () => {
  const { svgRaster } = await import('../src/rendering.js');
  const blank = await svgRaster('<svg viewBox="0 0 480 720"/>');
  const ruled = await svgRaster(
    '<svg viewBox="0 0 480 720"><path d="M40 114H440" stroke="black"/><line x1="40" y1="150" x2="440" y2="150" stroke="black"/></svg>',
  );
  assert.notEqual(ruled.data, blank.data);
  assert.equal(ruled.rendering.pixel_strokes_aligned, 2);
});
