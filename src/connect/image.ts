import sharp from 'sharp';
import { z } from 'zod';
import type { ArtifactStore } from '../os-artifacts.js';
export const ImageRequest = z
  .object({
    artifact_id: z.string(),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    fit: z.enum(['contain', 'cover', 'fill']).default('contain'),
    background: z.string().default('#ffffff'),
    format: z.enum(['png', 'rgb8', 'indexed8']).default('png'),
    palette: z
      .array(
        z.tuple([
          z.number().int().min(0).max(255),
          z.number().int().min(0).max(255),
          z.number().int().min(0).max(255),
        ]),
      )
      .min(1)
      .max(256)
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.width * v.height > 16 * 1024 * 1024)
      c.addIssue({ code: 'custom', message: 'Image pixel budget exceeded' });
    if (v.format === 'indexed8' && !v.palette)
      c.addIssue({ code: 'custom', message: 'Palette required for indexed8' });
  });
/** Generic resource preparation. Palette and geometry come from the selected
 * display contract; this module contains no panel encoding or waveform. */
export async function prepareImage(store: ArtifactStore, raw: unknown, signal: AbortSignal) {
  const v = ImageRequest.parse(raw),
    source = store.get(v.artifact_id);
  const release = store.pin([source]);
  try {
    signal.throwIfAborted();
    const pipeline = sharp(source.path, { limitInputPixels: 64 * 1024 * 1024, animated: false })
      .rotate()
      .resize(v.width, v.height, { fit: v.fit, background: v.background })
      .flatten({ background: v.background })
      .toColourspace('srgb');
    let result: Buffer;
    if (v.format === 'png') result = await pipeline.png().toBuffer();
    else {
      const rgb = await pipeline.removeAlpha().raw().toBuffer();
      if (v.format === 'rgb8') result = rgb;
      else {
        result = Buffer.alloc(v.width * v.height);
        const palette = v.palette!;
        for (let i = 0; i < result.length; i++) {
          if (i % 4096 === 0) {
            signal.throwIfAborted();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          let best = Infinity,
            index = 0;
          for (let p = 0; p < palette.length; p++) {
            const c = palette[p]!,
              distance =
                (rgb[i * 3]! - c[0]) ** 2 +
                (rgb[i * 3 + 1]! - c[1]) ** 2 +
                (rgb[i * 3 + 2]! - c[2]) ** 2;
            if (distance < best) {
              best = distance;
              index = p;
            }
          }
          result[i] = index;
        }
      }
    }
    signal.throwIfAborted();
    return {
      ...(await store.stageStream(
        (async function* () {
          yield result;
        })(),
        result.length,
        signal,
      )),
      width: v.width,
      height: v.height,
      format: v.format,
      ...(v.palette ? { palette: v.palette } : {}),
    };
  } finally {
    release();
  }
}
