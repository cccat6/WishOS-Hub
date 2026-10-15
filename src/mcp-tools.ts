import { RenderOptions } from './render-options.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Scene, Policy, RefreshProfile } from './protocol.js';
import {
  StreamRaster as Raster,
  MAX_RLE_BYTES,
  MAX_RASTER_BYTES,
  MAX_STREAM_RASTER_BYTES,
} from './raster.js';
import {
  svgRaster,
  imageRaster,
  textRaster,
  NativeTextLayout,
  ImageLayout,
  inspectImage,
} from './rendering.js';
import { imageFromUrl } from './image-source.js';

export type { HubApi } from './api-types.js';
import type { HubApi } from './api-types.js';
let rendering = 0;
async function render<T>(work: () => Promise<T>): Promise<T> {
  if (rendering >= 2)
    throw Error(
      'Renderer busy; retry after the current render finishes. No display command was queued.',
    );
  ++rendering;
  try {
    return await work();
  } finally {
    --rendering;
  }
}
const ImageSource = {
  path: z.string().min(1).max(4096).optional(),
  url: z.string().url().max(4096).optional(),
  data: z.string().max(1398104).optional(),
  mime_type: z.enum(['image/png', 'image/jpeg']).optional(),
};
async function withImageSource<T>(
  source: { path?: string; url?: string; data?: string; mime_type?: string },
  work: (path: string) => Promise<T>,
) {
  let { path, url, data, mime_type } = source;
  if ([path, url, data].filter(Boolean).length !== 1)
    throw Error('Provide exactly one image URL, server-local path or Base64 image data');
  let temporary: string | undefined;
  try {
    if (data || url) {
      const bytes = url ? await imageFromUrl(url) : Buffer.from(data!, 'base64');
      if (data && (!bytes.length || bytes.length > 1048576 || bytes.toString('base64') !== data))
        throw Error('Invalid image Base64 or image exceeds 1 MiB');
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216;
      if ((!png && !jpeg) || (mime_type && mime_type !== (png ? 'image/png' : 'image/jpeg')))
        throw Error('Expected PNG/JPEG bytes matching mime_type');
      temporary = await mkdtemp(join(tmpdir(), 'notes-mcp-image-'));
      path = join(temporary, png ? 'image.png' : 'image.jpg');
      await writeFile(path, bytes, { mode: 0o600 });
    }
    return await work(path!);
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
export function createNotesMcp(api: HubApi) {
  async function budget(device: string) {
    const response = await api(`/api/devices/${encodeURIComponent(device)}/state`);
    const capabilities = JSON.parse(response.content[0]!.text).capabilities;
    return !capabilities || capabilities.streaming_images
      ? Math.min(capabilities?.max_stream_bytes ?? MAX_STREAM_RASTER_BYTES, MAX_STREAM_RASTER_BYTES)
      : (capabilities.max_raster_bytes ?? MAX_RASTER_BYTES);
  }

  const server = new McpServer(
    { name: 'agentic-notes', version: '0.3.0' },
    {
      instructions:
        'Control Agentic Notes devices via the Hub. Commands are queued, not necessarily applied. Check command status before claiming the screen changed. Offline/deep-sleep devices cannot be woken over Wi-Fi. Do not assume battery charge percentage from VSYS. Scene-v1 has limited local glyphs; prefer present_text for horizontal Chinese/Latin with outline-aligned native pixels; self-contained SVG remains available for vector artwork and complex shaped text. Voice input is device initiated.',
    },
  );
  server.tool('list_devices', 'List connectivity, capabilities and last reported state.', {}, () =>
    api('/api/devices'),
  );
  server.tool(
    'get_device_state',
    'Read last reported state, including its timestamp.',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/state`),
  );
  server.tool(
    'refresh_harness_tools',
    'Ask the bound Harness to reload its configured MCP servers after an authorized tool setup change. Does not install tools, authenticate or grant permissions. Configured servers run their existing startup commands. A refresh request is not proof all tools connected; inspect get_harness_tools afterward.',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/tools`, {}),
  );
  server.tool(
    'get_harness_tools',
    'Read configured MCP tool availability in the device-bound Harness session, including Desktop host tools when connected. A configured server name is not proof its tools are callable; inspect status/errors. This catalog does not include every built-in or skill.',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/tools`),
  );
  server.tool(
    'get_harness_usage',
    'Read current account quota windows and credit balance from the device-bound Harness native account interface. This is read-only. Missing values are unknown; used_percent is consumed and remaining_percent is available. Credits are not a dollar balance. Call this before rendering Codex quota; no GUI, auth-file reads or manual user values are needed.',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/usage`),
  );
  server.tool(
    'present',
    'Queue a validated scene; returns command_id. This does not mean displayed.',
    {
      device_id: z.string(),
      request_id: z.string().optional(),
      scene: Scene,
      refresh_profile: RefreshProfile.optional(),
    },
    ({ device_id, request_id, scene, refresh_profile }) =>
      api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        payload: { op: 'display', scene, refresh_profile },
      }),
  );
  server.tool(
    'get_display_constraints',
    'Read rendering limits and unverified refresh capabilities; use live device capabilities separately.',
    {},
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            logical_size: [480, 720],
            native_scan_size: [720, 480],
            palette: [0, 1, 2, 3, 5, 6],
            scene_max_bytes: 8192,
            scene_max_commands: 48,
            rle_max_bytes: MAX_RLE_BYTES,
            native_raster_max_bytes: MAX_RASTER_BYTES,
            streaming_native_raster_max_bytes: MAX_STREAM_RASTER_BYTES,
            layout_sizes: { portrait: [480, 720], landscape: [720, 480] },
            orientation: 'explicit layout selection; no automatic refresh on IMU tilt',
            builtin_pages: ['ready', 'unconfigured', 'unavailable', 'failed'],
            status_policy:
              'voice release automatically queues a colorful fast processing page before final content; failures replace it with an error page; other transient networking pages remain omitted; shutdown clears white',
            voice_recording_limit_seconds: 300,
            host_font_families: ['noto', 'sarasa', 'plex'],
            native_text_tool:
              'present_text: FreeType monochrome at final pixel size; horizontal Chinese/Latin blocks; outline stem alignment by default; hinting=font restores font hints; hinting=auto forces automatic hints',
            native_font_sizes: [16, 20, 24, 32, 40, 48, 60],
            image_color_modes: ['nearest', 'dither', 'ordered', 'blue-noise', 'adaptive'],
            adaptive_photo:
              'Scene-adaptive tone strategy: classify native artwork, grayscale, flat illustration and continuous color. Dark scenes use p90 automatic exposure capped at +2 EV; scenes with bright backgrounds and colored shadows use bounded monotone shadow recovery from their shadow median; bright/flat sources remain unchanged. No saturation boost or individual ink suppression. Six-ink mixtures use a 128x128 blue-noise seed followed by local swaps that preserve ink counts and improve contour placement; cyan and neutral gray are preserved. Native text is overlaid after this step. present_image defaults to this mode with factory refresh.',
            image_layout:
              'inspect_image returns dimensions and source preview. present_image layout supports contain/cover/stretch, normalized crop, anchor, native-pixel frame and native text blocks; portrait 480x720, landscape 720x480.',
            native_input_rule: 'strict (legacy color_mode alias retained)',
            canonical_rgb: {
              black: '#000000',
              white: '#ffffff',
              yellow: '#ffff00',
              red: '#ff0000',
              blue: '#0000ff',
              green: '#00ff00',
            },
            color_processing:
              'host only; nearest flat color, Floyd-Steinberg diffusion, convex-palette Bayer ordered or void-and-cluster blue-noise mixtures',
            strict_palette:
              'exact native 480x720 canonical six-color pixels; invalid_color defaults to black (0), supports other replacement codes or error',
            experimental_text_raster: {
              mode: 'square',
              strength: ['balanced', 'crisp'],
              requires:
                'coverage text layer; host-only unit-square contour optimization; not visually accepted',
            },
            font_edges:
              'Regular 400; J outline stem alignment for device/local text and supported SVG text; explicit vector compatibility for complex SVG; text is protected from image dithering',
            svg: 'supported opaque regular SVG text uses J; unsupported typography fails in default strict grid mode; svg_text_mode=vector opts into full SVG compatibility; no external resources/scripts',
            image:
              'PNG/JPEG converted to native 480x720 NMP1 with lossless stripe compression; oversized content is rejected, never silently downsampled',
            text: 'ASCII and built-in CJK glyph subset; arbitrary fonts require host rasterization',
            fast_refresh:
              'fast is the firmware default; single-board room-temperature visual check passed, wider verification pending',
            refresh_profiles: ['factory', 'fast'],
            per_image_refresh_parameter: 'refresh_profile; omission uses the device default',
            partial_refresh: 'unverified',
            busy_timing_is_not_optical_timing: true,
          }),
        },
      ],
    }),
  );
  server.tool(
    'present_status',
    'Queue a persistent built-in page with portrait or landscape layout. Error status preserves existing content; transient loading/connection/charging pages are not available.',
    {
      device_id: z.string(),
      request_id: z.string().optional(),
      name: z.enum(['ready', 'unconfigured', 'unavailable', 'failed']),
      orientation: z.enum(['portrait', 'landscape']).optional(),
      refresh_profile: RefreshProfile.optional(),
    },
    ({ device_id, request_id, name, orientation, refresh_profile }) =>
      api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        payload: { op: 'builtin', name, orientation, refresh_profile },
      }),
  );
  server.tool(
    'present_svg',
    'Render self-contained vector SVG and arbitrary Chinese text with selectable bundled sans-serif fonts at native resolution, then queue its lossless compressed raster.',
    {
      device_id: z.string(),
      request_id: z.string().optional(),
      svg: z.string().max(65536),
      refresh_profile: RefreshProfile.optional(),
      rendering: RenderOptions.optional(),
    },
    async ({ device_id, request_id, svg, refresh_profile, rendering }) => {
      const raster = await render(async () => svgRaster(svg, rendering, await budget(device_id)));
      return api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        payload: { op: 'display_rle', data: raster.data, refresh_profile },
      });
    },
  );
  server.tool(
    'present_text',
    'Render horizontal Chinese/Latin text blocks with native-size FreeType monochrome glyphs, wrapping and selectable hinted fonts; returns a queued command, not display completion.',
    {
      device_id: z.string(),
      request_id: z.string().optional(),
      layout: NativeTextLayout,
      refresh_profile: RefreshProfile.optional(),
    },
    async ({ device_id, request_id, layout, refresh_profile }) => {
      const raster = await render(async () => textRaster(layout, await budget(device_id)));
      const result = await api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        payload: { op: 'display_rle', data: raster.data, refresh_profile },
      });
      const command = JSON.parse(result.content[0]!.text);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ...command, rendering: raster.rendering }) },
        ],
      };
    },
  );
  server.tool(
    'present_raster',
    'Queue native NMP1 Base64 (up to 180000 bytes through negotiated streaming) or legacy NMR1 (max 6000 bytes); requires matching device capability.',
    {
      device_id: z.string(),
      request_id: z.string().optional(),
      data: Raster,
      refresh_profile: RefreshProfile.optional(),
    },
    ({ device_id, request_id, data, refresh_profile }) =>
      api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        payload: { op: 'display_rle', data, refresh_profile },
      }),
  );
  server.tool(
    'inspect_image',
    'Read an image source without changing the display. Returns EXIF-oriented dimensions and a preview for choosing crop, focus and layout.',
    ImageSource,
    async (source) =>
      render(() =>
        withImageSource(source, async (path) => {
          const result = await inspectImage(path);
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result.metadata) },
              {
                type: 'image' as const,
                mimeType: 'image/jpeg',
                data: result.preview.toString('base64'),
              },
            ],
          };
        }),
      ),
  );
  server.tool(
    'present_image',
    'Fetch a PNG/JPEG URL or use a local file/Base64; crop, scale and compose native text with layout, convert to six inks and queue it. Defaults to scene-adaptive tone with six-ink coverage and ink-count-preserving local placement optimization, plus factory refresh for correct colors. Explicit conversion and refresh overrides remain available. Requires nmp1 firmware.',
    {
      device_id: z.string(),
      request_id: z.string().optional(),
      ...ImageSource,
      force: z.boolean().optional(),
      layout: ImageLayout.optional(),
      refresh_profile: RefreshProfile.optional(),
      rendering: RenderOptions.optional(),
    },
    async ({
      device_id,
      request_id,
      path,
      url,
      data,
      mime_type,
      refresh_profile,
      rendering,
      layout,
      force,
    }) => {
      const effectiveRendering = {
        ...rendering,
        color_mode:
          rendering?.color_mode ?? (rendering?.input_rule === 'exact' ? 'strict' : 'adaptive'),
      };
      const effectiveProfile = refresh_profile ?? 'factory';
      const raster = await render(() =>
        withImageSource({ path, url, data, mime_type }, async (source) =>
          imageRaster(
            source,
            effectiveRendering,
            undefined,
            undefined,
            undefined,
            await budget(device_id),
            layout,
          ),
        ),
      );
      const result = await api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        payload: { op: 'display_rle', data: raster.data, refresh_profile: effectiveProfile, force },
      });
      const command = JSON.parse(result.content[0]!.text);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ...command, rendering: raster.rendering }) },
        ],
      };
    },
  );
  server.tool(
    'request_maintenance',
    'Replay the last successful display through normal refresh; returns a command receipt, not immediate completion.',
    { device_id: z.string(), request_id: z.string().optional() },
    ({ device_id, request_id }) =>
      api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        ttl_s: 3600,
        payload: { op: 'maintenance' },
      }),
  );
  server.tool(
    'request_shutdown',
    'Clear to white, then release OPT. Device may go offline and cannot be woken over Wi-Fi.',
    { device_id: z.string(), request_id: z.string().optional() },
    ({ device_id, request_id }) =>
      api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        ttl_s: 300,
        payload: { op: 'shutdown' },
      }),
  );
  server.tool(
    'resume_powered_standby',
    'Resume a still-powered logical-off device. This cannot switch on a physically powered-off board.',
    { device_id: z.string(), request_id: z.string().optional() },
    ({ device_id, request_id }) =>
      api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        ttl_s: 60,
        payload: { op: 'resume' },
      }),
  );
  server.tool(
    'get_command_status',
    'Check whether a device command completed, failed, expired or is uncertain.',
    { command_id: z.string() },
    ({ command_id }) => api(`/api/commands/${encodeURIComponent(command_id)}`),
  );
  server.tool(
    'set_device_policy',
    'Set volatile operating mode, polling interval, IMU wake or display profile. Network credentials are not editable through this tool.',
    { device_id: z.string(), request_id: z.string().optional(), policy: Policy },
    ({ device_id, request_id, policy }) =>
      api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        payload: { op: 'policy', policy },
      }),
  );
  server.tool(
    'request_sleep',
    'Request timed deep sleep. Wi-Fi is unreachable until local/timer wake. Busy hardware may reject.',
    {
      device_id: z.string(),
      seconds: z.number().int().min(60).max(604800),
      request_id: z.string().optional(),
    },
    ({ device_id, seconds, request_id }) =>
      api(`/api/devices/${encodeURIComponent(device_id)}/commands`, {
        request_id: request_id ?? randomUUID(),
        ttl_s: 60,
        payload: { op: 'sleep', seconds },
      }),
  );
  server.resource(
    'display_guide',
    'notes://display-guide',
    { mimeType: 'text/plain' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: await readFile(
            fileURLToPath(new URL('../skills/agentic-notes/SKILL.md', import.meta.url)),
            'utf8',
          ),
        },
      ],
    }),
  );
  server.tool(
    'get_device_events',
    'Read recent device button, IMU and voice-related events with timestamps; reading does not consume them.',
    { device_id: z.string() },
    async ({ device_id }) => {
      const result = await api(`/api/devices/${encodeURIComponent(device_id)}/state`);
      const state = JSON.parse(result.content[0]!.text);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              device_id,
              online: state.online,
              last_seen: state.last_seen,
              recent_events: state.recent_events,
            }),
          },
        ],
      };
    },
  );
  return server;
}
