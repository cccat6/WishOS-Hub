import { z } from 'zod';
import { RenderOptions } from './render-options.js';
import { renderAsync } from './svg-artwork.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scene } from './protocol.js';
import { StreamRaster as Raster, MAX_RASTER_BYTES } from './raster.js';
const root = fileURLToPath(new URL('../', import.meta.url));
let fontCatalog: Promise<Record<string, { family: string; files: string[] }>> | undefined;
function legacyFontCatalog(): Promise<Record<string, { family: string; files: string[] }>> {
  return (fontCatalog ??= readFile(join(root, 'assets/fonts/catalog.json'), 'utf8').then((text) =>
    JSON.parse(text),
  ));
}
const python =
  process.env.NOTES_RENDER_PYTHON ??
  (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
const exec = promisify(execFile);
async function convert(args: string[]) {
  // No shell, external SVG resource fetches, or inherited Hub secrets.
  return exec(python, [join(root, 'tools/content.py'), ...args], {
    timeout: 45000,
    maxBuffer: 65536,
    env: { PATH: process.env.PATH ?? '' },
  });
}
export async function svgScene(svg: string) {
  if (Buffer.byteLength(svg) > 65536) throw Error('SVG exceeds 64 KiB');
  const dir = await mkdtemp(join(tmpdir(), 'notes-svg-'));
  try {
    const source = join(dir, 'source.svg'),
      dest = join(dir, 'scene.json');
    await writeFile(source, svg, { mode: 0o600 });
    await convert(['svg', source, dest]);
    return Scene.parse(JSON.parse(await readFile(dest, 'utf8')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function imageRaster(
  path: string,
  options: RenderOptions = {},
  textLayer?: string,
  glyphMask?: string,
  textArt?: string,
  maximum = MAX_RASTER_BYTES,
  layout?: z.infer<typeof ImageLayout>,
) {
  options = RenderOptions.parse(options);
  if (options.input_rule === 'exact') options = { ...options, color_mode: 'strict' };
  if (layout) {
    layout = ImageLayout.parse(layout);
    if (options.color_mode === 'strict')
      throw Error('Exact input does not permit image layout changes');
  }
  const source = resolve(path);
  if (!['.png', '.jpg', '.jpeg'].includes(extname(source).toLowerCase()))
    throw Error('Use a local PNG/JPEG file');
  const info = await stat(source);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw Error('Image file exceeds 16 MiB');
  const dir = await mkdtemp(join(tmpdir(), 'notes-image-'));
  try {
    const dest = join(dir, 'image.nmp');
    const args = [
      'image',
      source,
      dest,
      '--max-bytes',
      String(maximum),
      '--color-mode',
      options.color_mode ?? 'nearest',
      '--palette',
      options.palette ?? 'canonical',
      '--invalid-color',
      String(options.invalid_color ?? 0),
      '--edge-mode',
      options.edge_mode ?? 'source',
      '--text-regions',
      JSON.stringify(options.text_regions ?? []),
    ];
    args.push('--orientation', options.orientation ?? 'portrait');
    if (options.adaptive_strength !== undefined)
      args.push('--adaptive-strength', String(options.adaptive_strength));
    if (layout) args.push('--image-layout', JSON.stringify(layout));
    args.push('--text-sampling', options.text_sampling ?? 'original');
    args.push('--text-raster', options.text_raster ?? 'threshold');
    args.push('--text-square-strength', options.text_square_strength ?? 'balanced');
    if (options.text_threshold !== undefined)
      args.push('--text-threshold', String(options.text_threshold));
    if (textLayer) args.push('--text-layer', textLayer);
    if (glyphMask) args.push('--glyph-mask', glyphMask);
    if (textArt) args.push('--text-art', textArt);
    const run = await convert(args);
    const data = Raster.parse((await readFile(dest)).toString('base64'));
    const conversion = JSON.parse(/render_metadata=(.+)/.exec(run.stdout)?.[1] ?? '{}') as {
      invalid_pixels?: number;
      replaced_pixels?: number;
      square_text?: Record<string, unknown> | null;
      protected_glyph_pixels?: number;
      photo_tone?: Record<string, unknown> | null;
      sampling_optimization?: Record<string, unknown> | null;
      image_layout?: Record<string, unknown> | null;
    };
    const factor = Number(/detail reduction factor=(\d+)/.exec(run.stdout)?.[1] ?? NaN);
    if (![1, 2, 4, 8, 16].includes(factor)) throw Error('Invalid renderer metadata');
    return {
      data,
      rendering: {
        format: 'nmp1',
        native_resolution: true,
        invalid_pixels: conversion.invalid_pixels ?? 0,
        replaced_pixels: conversion.replaced_pixels ?? 0,
        color_mode: options.color_mode ?? 'nearest',
        photo_tone: conversion.photo_tone ?? null,
        sampling_optimization: conversion.sampling_optimization ?? null,
        image_layout: conversion.image_layout ?? null,
        input_rule: options.color_mode === 'strict' ? 'exact' : 'convert',
        palette: options.palette ?? 'canonical',
        edge_mode: options.edge_mode ?? 'source',
        dither_algorithm:
          options.color_mode === 'dither'
            ? 'floyd-steinberg-linear-rgb'
            : options.color_mode === 'adaptive'
              ? 'void-cluster128-convex-linear-rgb-local-swap-after-scene-adaptive-tone'
              : options.color_mode === 'ordered'
                ? 'bayer8-convex-linear-rgb'
                : options.color_mode === 'blue-noise'
                  ? 'void-cluster128-convex-linear-rgb'
                  : null,
        font_family: textLayer ? (options.font_family ?? 'noto') : null,
        text_raster: textLayer ? (options.text_raster ?? 'threshold') : null,
        square_text: conversion.square_text ?? null,
        text_sampling: textLayer ? (options.text_sampling ?? 'original') : null,
        text_scale: textLayer
          ? options.text_sampling === 'coverage'
            ? (options.text_scale ?? 4)
            : 2
          : null,
        text_threshold: textLayer
          ? (options.text_threshold ?? (options.text_sampling === 'coverage' ? 128 : 101))
          : null,
        strict_invalid_color: options.color_mode === 'strict' ? (options.invalid_color ?? 0) : null,
        protected_glyph_pixels: conversion.protected_glyph_pixels ?? 0,
        text_protected: Boolean(
          textLayer || glyphMask || options.text_regions?.length || layout?.blocks?.length,
        ),
        text_dithered:
          textLayer || glyphMask || options.text_regions?.length || layout?.blocks?.length
            ? false
            : null,
        palette_calibrated: false,
        bytes: Buffer.from(data, 'base64').length,
        detail_reduction_factor: factor,
        orientation: options.orientation ?? 'portrait',
        storage_size: [480, 720],
        logical_detail:
          options.orientation === 'landscape'
            ? [720 / factor, 480 / factor]
            : [480 / factor, 720 / factor],
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function svgRaster(
  svg: string,
  options: RenderOptions = {},
  maximum = MAX_RASTER_BYTES,
) {
  options = RenderOptions.parse(options);
  if (options.input_rule === 'exact') options = { ...options, color_mode: 'strict' };
  const edge = options.edge_mode ?? (options.color_mode === 'strict' ? 'source' : 'epaper');
  options = { ...options, edge_mode: edge };
  if (Buffer.byteLength(svg) > 65536) throw Error('SVG exceeds 64 KiB');
  const dir = await mkdtemp(join(tmpdir(), 'notes-vector-'));
  try {
    const source = join(dir, 'source.svg'),
      safe = join(dir, 'safe.svg'),
      png = join(dir, 'render.png');
    await writeFile(source, svg, { mode: 0o600 });
    await exec(python, [join(root, 'tools/safe_svg.py'), source, safe], {
      timeout: 45000,
      maxBuffer: 65536,
      env: { PATH: process.env.PATH ?? '' },
    });
    const chosenFont = (await legacyFontCatalog())[options.font_family ?? 'noto']!;
    const fonts = {
      fontFiles: chosenFont.files.map((file) => join(root, 'assets/fonts', file)),
      loadSystemFonts: false,
      defaultFontFamily: chosenFont.family,
      sansSerifFamily: chosenFont.family,
    };
    const layoutWidth = options.orientation === 'landscape' ? 720 : 480;
    const width = options.color_mode === 'strict' ? layoutWidth : layoutWidth * 4;
    const legacyText =
      options.text_sampling !== undefined ||
      options.text_threshold !== undefined ||
      options.text_raster !== undefined ||
      options.text_scale !== undefined;
    const textMode = options.svg_text_mode ?? (legacyText ? 'vector' : 'grid');
    if (edge === 'epaper' && options.color_mode !== 'strict' && textMode === 'grid') {
      const grid = join(dir, 'grid.svg'),
        maskSvg = join(dir, 'mask.svg'),
        maskPng = join(dir, 'mask.png');
      const prepared = await exec(
        python,
        [
          join(root, 'tools/svg_grid_text.py'),
          safe,
          grid,
          maskSvg,
          options.font_family ?? 'noto',
          options.palette ?? 'canonical',
          options.strict_text === false ? '0' : '1',
          options.orientation ?? 'portrait',
        ],
        { timeout: 45000, maxBuffer: 65536, env: { PATH: process.env.PATH ?? '' } },
      );
      const metadata = JSON.parse(prepared.stdout);
      const [image, mask] = await Promise.all([
        renderAsync(await readFile(grid), {
          background: 'white',
          font: fonts,
          fitTo: { mode: 'width', value: layoutWidth * 4 },
        }),
        renderAsync(await readFile(maskSvg), {
          background: 'rgba(0,0,0,0)',
          font: fonts,
          fitTo: { mode: 'width', value: layoutWidth * 4 },
        }),
      ]);
      await writeFile(png, image.asPng());
      await writeFile(maskPng, mask.asPng());
      const result = await imageRaster(png, options, undefined, maskPng, undefined, maximum);
      return {
        ...result,
        rendering: {
          ...result.rendering,
          font_family: options.font_family ?? 'noto',
          svg_text_mode: 'grid',
          text_raster: metadata.vector_fallbacks.length ? 'mixed' : 'stems',
          text_sampling: 'native',
          text_threshold: null,
          text_scale: 1,
          ...metadata,
        },
      };
    }
    if (edge === 'epaper' && options.color_mode !== 'strict') {
      const artwork = join(dir, 'art.svg'),
        text = join(dir, 'text.svg'),
        layer = join(dir, 'text.png');
      await exec(python, [join(root, 'tools/svg_text_layers.py'), safe, artwork, text], {
        timeout: 45000,
        maxBuffer: 65536,
        env: { PATH: process.env.PATH ?? '' },
      });
      const [artRender, textRender, fullRender] = await Promise.all([
        renderAsync(await readFile(artwork), {
          background: 'white',
          font: fonts,
          fitTo: { mode: 'width', value: width },
          textRendering: 2,
          shapeRendering: 2,
        }),
        renderAsync(await readFile(text), {
          background: 'rgba(0,0,0,0)',
          font: fonts,
          fitTo: {
            mode: 'width',
            value:
              options.text_sampling === 'coverage'
                ? layoutWidth * (options.text_scale ?? 4)
                : layoutWidth * 2,
          },
          textRendering: 2,
          shapeRendering: 2,
        }),
        renderAsync(await readFile(safe), {
          background: 'white',
          font: fonts,
          fitTo: { mode: 'width', value: width },
          textRendering: 2,
          shapeRendering: 2,
        }),
      ]);
      const artPng = join(dir, 'art.png');
      await writeFile(png, fullRender.asPng());
      await writeFile(artPng, artRender.asPng());
      await writeFile(layer, textRender.asPng());
      return await imageRaster(png, options, layer, undefined, artPng, maximum);
    }
    const rendered = await renderAsync(await readFile(safe), {
      background: 'white',
      font: fonts,
      fitTo: { mode: 'width', value: width },
      textRendering: 2,
      shapeRendering: 2,
    });
    await writeFile(png, rendered.asPng());
    const raster = await imageRaster(png, options, undefined, undefined, undefined, maximum);
    raster.rendering.font_family = options.font_family ?? 'noto';
    return raster;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const NativeTextBlock = z
  .object({
    x: z.number().int().min(0).max(719),
    y: z.number().int().min(0).max(719),
    w: z.number().int().min(1).max(720),
    h: z.number().int().min(1).max(720),
    text: z.string().max(4000),
    font_family: z.enum(['noto', 'sarasa', 'plex']).optional(),
    font_size: z.number().int().min(8).max(96).optional(),
    hinting: z.enum(['font', 'auto', 'stems']).optional(),
    baseline_mode: z.enum(['ink', 'font']).optional(),
    color: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(6)])
      .optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    line_height: z.number().int().min(8).max(160).optional(),
  })
  .strict();
export const NativeTextLayout = z
  .object({
    background: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(6)])
      .optional(),
    orientation: z.enum(['portrait', 'landscape']).optional(),
    blocks: z.array(NativeTextBlock).min(1).max(32),
  })
  .strict();
const Unit = z.number().min(0).max(1);
export const ImageLayout = z
  .object({
    fit: z.enum(['contain', 'cover', 'stretch']).optional(),
    crop: z
      .object({ x: Unit, y: Unit, w: Unit.gt(0), h: Unit.gt(0) })
      .strict()
      .refine((c) => c.x + c.w <= 1 && c.y + c.h <= 1, 'Normalized crop outside source')
      .optional(),
    anchor: z.object({ x: Unit, y: Unit }).strict().optional(),
    frame: z
      .object({
        x: z.number().int().min(0).max(719),
        y: z.number().int().min(0).max(719),
        w: z.number().int().min(1).max(720),
        h: z.number().int().min(1).max(720),
      })
      .strict()
      .optional(),
    background: NativeTextLayout.shape.background,
    blocks: z.array(NativeTextBlock).max(32).optional(),
  })
  .strict();
export async function inspectImage(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw Error('Image file exceeds 16 MiB');
  const dir = await mkdtemp(join(tmpdir(), 'notes-image-info-'));
  try {
    const preview = join(dir, 'preview.jpg');
    const run = await exec(python, [join(root, 'tools/image_layout.py'), path, preview], {
      timeout: 30000,
      maxBuffer: 65536,
      env: { PATH: process.env.PATH ?? '' },
    });
    return { metadata: JSON.parse(run.stdout), preview: await readFile(preview) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function textRaster(
  layout: z.infer<typeof NativeTextLayout>,
  maximum = MAX_RASTER_BYTES,
) {
  layout = NativeTextLayout.parse(layout);
  const dir = await mkdtemp(join(tmpdir(), 'notes-native-text-'));
  try {
    const source = join(dir, 'layout.json'),
      dest = join(dir, 'text.nmp');
    const json = JSON.stringify(layout);
    if (Buffer.byteLength(json) > 65536) throw Error('Text layout exceeds 64 KiB');
    await writeFile(source, json, { mode: 0o600 });
    const run = await exec(
      python,
      [join(root, 'tools/native_text.py'), source, dest, '--max-bytes', String(maximum)],
      {
        timeout: 45000,
        maxBuffer: 65536,
        env: { PATH: process.env.PATH ?? '' },
      },
    );
    const data = Raster.parse((await readFile(dest)).toString('base64'));
    return { data, rendering: { format: 'nmp1', ...JSON.parse(run.stdout) } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
