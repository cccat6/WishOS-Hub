import { z } from 'zod';
import { StreamRaster as Raster } from './raster.js';

export const PROTOCOL = 2;
export const MAX_WIRE = 16 * 1024;
export const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const Color = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(6),
]);
const Position = {
  x: z.number().int().min(0).max(479),
  y: z.number().int().min(0).max(719),
  color: Color,
};
const Text = z.string().refine((s) => Buffer.byteLength(s) <= 96, 'text exceeds 96 UTF-8 bytes');
export const Scene = z
  .object({
    format: z.literal('scene-v1'),
    background: Color,
    commands: z
      .array(
        z.union([
          z
            .object({
              op: z.literal('text'),
              ...Position,
              text: Text,
              scale: z.number().int().min(1).max(4).optional().default(2),
              font_size: z
                .union([
                  z.literal(16),
                  z.literal(20),
                  z.literal(24),
                  z.literal(32),
                  z.literal(40),
                  z.literal(48),
                  z.literal(60),
                ])
                .optional(),
            })
            .strict(),
          z
            .object({
              op: z.literal('icon'),
              ...Position,
              name: z.enum(['wifi', 'wifi-off', 'circle-check', 'circle-x', 'file-text']),
              w: z.number().int().min(8).max(96),
              h: z.number().int().min(8).max(96),
            })
            .strict()
            .refine((c) => c.x + c.w <= 480 && c.y + c.h <= 720, 'icon outside screen'),
          z
            .object({
              op: z.enum(['fill', 'rect', 'line', 'circle']),
              ...Position,
              w: z.number().int().min(0).max(720),
              h: z.number().int().min(0).max(720),
            })
            .strict(),
        ]),
      )
      .max(48),
  })
  .strict()
  .refine((s) => Buffer.byteLength(JSON.stringify(s)) <= 8192, 'scene too large');
export type Scene = z.infer<typeof Scene>;
export const RefreshProfile = z.enum(['factory', 'fast']);
export const ContentHash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional();
export const Policy = z
  .object({
    mode: z.enum(['online', 'periodic', 'offline']).optional(),
    interval_s: z.number().int().min(60).max(604800).optional(),
    window_s: z.number().int().min(30).max(600).optional(),
    audio: z.boolean().optional(),
    imu_wake: z.boolean().optional(),
    display_profile: RefreshProfile.optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'empty policy');
export const CommandPayload = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('display_rle'),
      data: Raster,
      voice_feedback: z.boolean().optional(),
      refresh_profile: RefreshProfile.optional(),
      content_hash: ContentHash,
      force: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('display'),
      scene: Scene,
      refresh_profile: RefreshProfile.optional(),
      content_hash: ContentHash,
      force: z.boolean().optional(),
      experiment: z
        .object({
          spi_hz: z.union([z.literal(2000000), z.literal(4000000), z.literal(8000000)]).optional(),
          keep_initialized: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ op: z.literal('shutdown') }).strict(),
  z.object({ op: z.literal('resume') }).strict(),
  z.object({ op: z.literal('maintenance') }).strict(),
  z
    .object({
      op: z.literal('builtin'),
      refresh_profile: RefreshProfile.optional(),
      name: z.enum(['ready', 'unconfigured', 'unavailable', 'failed', 'welcome']),
      orientation: z.enum(['portrait', 'landscape']).optional(),
    })
    .strict(),
  z.object({ op: z.literal('policy'), policy: Policy }).strict(),
  z.object({ op: z.literal('sleep'), seconds: z.number().int().min(60).max(604800) }).strict(),
]);
export type CommandPayload = z.infer<typeof CommandPayload>;
export const CommandRequest = z
  .object({
    request_id: Id,
    ttl_s: z.number().int().min(5).max(86400).default(3600),
    payload: CommandPayload,
  })
  .strict();
export const DeviceMessage = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      protocol: z.literal(PROTOCOL),
      device_id: Id,
      boot_id: Id,
      capabilities: z
        .object({
          display: z.boolean(),
          audio: z.boolean(),
          voice_feedback: z.boolean().optional(),
          sleep: z.boolean(),
          max_scene_bytes: z.number().int().min(1).max(8192),
          formats: z
            .array(z.enum(['scene-v1', 'nmr1', 'nmp1']))
            .max(3)
            .optional(),
          max_rle_bytes: z.number().int().min(15).max(6000).optional(),
          max_raster_bytes: z.number().int().min(18).max(8000).optional(),
          fragmented_commands: z.boolean().optional(),
          streaming_images: z.boolean().optional(),
          max_stream_bytes: z.number().int().min(18).max(180000).optional(),
          refresh_profiles: z.array(RefreshProfile).max(2).optional(),
          builtin_layouts: z
            .array(z.enum(['portrait', 'landscape']))
            .max(2)
            .optional(),
          builtin_pages: z
            .array(z.enum(['ready', 'unconfigured', 'unavailable', 'failed']))
            .max(4)
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('state'), state: z.record(z.unknown()) }).strict(),
  z
    .object({
      type: z.literal('event'),
      seq: z.number().int().nonnegative(),
      name: z.enum(['boot', 'timer', 'act.click', 'power.press', 'imu', 'audio.unavailable']),
      at_ms: z.number().nonnegative(),
      context: z
        .object({
          sample_age_ms: z.number().int().min(0).max(4294967295),
          vsys_mv: z.number().int().min(0).max(10000),
          charging: z.boolean(),
          act: z.boolean(),
          power: z.boolean(),
          imu_valid: z.boolean(),
          imu_xyz: z.array(z.number().int().min(-32768).max(32767)).length(3),
          mic_enabled: z.boolean(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('ack'),
      command_id: Id,
      status: z.enum(['accepted', 'running', 'completed', 'failed', 'rejected']),
      detail: z.string().max(256).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('audio.start'),
      stream_id: Id,
      sample_rate: z.literal(16000),
      channels: z.literal(1),
      sample_bits: z.literal(16),
      frame_samples: z.union([z.literal(320), z.literal(1280)]).optional(),
      encoding: z.enum(['pcm-s16le', 'ima-adpcm']).optional(),
      diagnostic: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('audio.end'),
      stream_id: Id,
      chunks: z.number().int().nonnegative(),
      complete: z.boolean(),
      error: z.string().max(64).optional(),
      total_samples: z.number().int().min(1).max(4800000).optional(),
      dropped_samples: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type DeviceMessage = z.infer<typeof DeviceMessage>;
export const SessionInput = z
  .object({
    request_id: Id,
    text: z.string().min(1).max(16000),
    session_id: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\r\n\0]/.test(value))
      .nullable()
      .optional(),
  })
  .strict();
export const terminal = new Set([
  'completed',
  'failed',
  'rejected',
  'expired',
  'superseded',
  'uncertain',
]);
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
