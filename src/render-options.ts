import { z } from 'zod';
export const ColorMode = z.enum([
  'nearest',
  'dither',
  'ordered',
  'blue-noise',
  'adaptive',
  'strict',
]);
export const EdgeMode = z.enum(['source', 'epaper']);
export const RenderOptions = z
  .object({
    color_mode: ColorMode.optional(),
    adaptive_strength: z.number().min(0).max(1.5).optional(),
    orientation: z.enum(['portrait', 'landscape']).optional(),
    font_family: z.enum(['noto', 'sarasa', 'plex']).optional(),
    svg_text_mode: z.enum(['grid', 'vector']).optional(),
    strict_text: z.boolean().optional(),
    input_rule: z.enum(['convert', 'exact']).optional(),
    palette: z.enum(['canonical', 'display']).optional(),
    invalid_color: z
      .union([
        z.literal('error'),
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(5),
        z.literal(6),
      ])
      .optional(),
    edge_mode: EdgeMode.optional(),
    text_sampling: z.enum(['original', 'coverage']).optional(),
    text_raster: z.enum(['threshold', 'square']).optional(),
    text_square_strength: z.enum(['balanced', 'crisp']).optional(),
    text_threshold: z.number().int().min(64).max(192).optional(),
    text_scale: z.union([z.literal(4), z.literal(8), z.literal(16)]).optional(),
    text_regions: z
      .array(
        z
          .object({
            x: z.number().int().min(0).max(719),
            y: z.number().int().min(0).max(719),
            w: z.number().int().min(1).max(720),
            h: z.number().int().min(1).max(720),
          })
          .strict(),
      )
      .max(32)
      .optional(),
  })
  .strict()
  .superRefine((options, ctx) => {
    if (options.adaptive_strength !== undefined && options.color_mode !== 'adaptive')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'adaptive_strength requires adaptive color mode',
      });
    if (
      options.text_raster === 'square' &&
      (options.text_sampling !== 'coverage' || options.edge_mode === 'source')
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'square text requires coverage sampling and epaper edges',
      });
    if (options.text_square_strength !== undefined && options.text_raster !== 'square')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text_square_strength requires square text',
      });
    if (options.text_scale !== undefined && options.text_sampling !== 'coverage')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'text_scale requires coverage sampling',
      });
    if (options.input_rule === 'convert' && options.color_mode === 'strict')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'strict is an exact input rule, not a color conversion',
      });
    if (options.input_rule === 'exact' && options.color_mode && options.color_mode !== 'strict')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exact input does not run color conversion',
      });
    if (
      (options.input_rule === 'exact' || options.color_mode === 'strict') &&
      (options.text_sampling !== undefined ||
        options.text_threshold !== undefined ||
        options.text_scale !== undefined ||
        options.text_raster !== undefined ||
        options.text_square_strength !== undefined)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exact input does not rewrite text edges',
      });
  });
export type RenderOptions = z.infer<typeof RenderOptions>;
