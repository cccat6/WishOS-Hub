import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod-modern';
import type { HubApi } from './api-types.js';
/** Model-facing integration for the portable resource ABI. No device geometry,
 * palette, application page or physical refresh sequence is defined here. */
export function createWishosMcp(api: HubApi, options = { imagePreparation: true }) {
  const server = new McpServer(
    { name: 'wishos', version: '1.0.0' },
    {
      supportedProtocolVersions: [
        '2026-07-28',
        '2025-11-25',
        '2025-06-18',
        '2025-03-26',
        '2024-11-05',
      ],
      instructions:
        'Discover the selected device and resource capabilities first. Use /sys/apps for installed package references and lifecycle, and inspect the selected default package source as a hardware-specific reference. The launcher is an ordinary replaceable application. Preserve the independent /sys/navigation home/voice entry; explain controls, first-use guidance, help and task feedback when creating or changing an application. Do not introduce active/passive user work modes. Hardware drivers are compiled; UI, pages, input meanings and application behavior are ordinary runtime packages that can be replaced without firmware changes. UI layout, font/image rendering and presentation are system services; applications provide descriptions and behavior. Applications use /services/ai for managed AI requests; provider and Harness protocols belong to the user-owned connector. New results are ordered application/system actions, which may alternate. Discover the result/2 schema, receiver identity and completion contract before generating a sequence. The system coordinates application replacement after the appropriate notifications. Stage large files/code/images on the Hub with stage_resource; do not send arbitrary source download URLs to the device. Inspect /sys/transfers storage policy, physical partitions, quotas and runtime parser budgets. Pre-extract large JSON/XML and index books upstream. Use a presentation effect for UI-only output. Inspect /sys/ui capabilities and a device-provided UI example before generating its document format. Logs and telemetry are separate system services; never include prompts, credentials, audio or arbitrary log text in telemetry. Use advertised resource calls and file paths, never GPIO/register access. Keep deterministic work local; use a remote route only for an explicit application action. An accepted request is not physical completion: inspect its completion/event receipt. A timed-out mutation must be reconciled before retry. Display drivers declare their own colors, geometry and completion models; never infer them from the MCU or a previous device. Recordings are compressed blocks; durable upload, speech recognition, Harness admission and displayed output are separate stages. Use the existing Harness session tools for the user task, then explicitly present the result through the device resources.',
    },
  );
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (input: z.infer<z.ZodObject<S>>) => ReturnType<HubApi>,
  ) {
    server.registerTool(name, { description, inputSchema: z.object(shape) }, run);
  }
  const invoke = async (
    device: string,
    path: string,
    method: string,
    args: Record<string, unknown>,
    boot?: string,
    requestId?: string,
  ) => {
    const reply = await api(`/api/os/devices/${encodeURIComponent(device)}/invoke`, {
      path,
      method,
      args,
      ...(requestId ? { request_id: requestId } : {}),
      ...(boot ? { expected_boot_id: boot } : {}),
    });
    return { ...reply, isError: JSON.parse(reply.content[0]!.text).ok === false };
  };
  tool(
    'server_capabilities',
    'Read this MCP deployment resource limits and available server preparation capabilities; device capabilities are discovered separately.',
    {},
    () => api('/api/service'),
  );
  tool('list_devices', 'List connected devices and their transport state.', {}, () =>
    api('/api/devices'),
  );
  tool(
    'device_state',
    'Read device, Harness and connection state.',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/state`),
  );
  tool(
    'discover_resources',
    'Read one page of the live resource catalog. Continue while more is true; detailed method schemas are read separately.',
    { device_id: z.string(), cursor: z.number().int().min(0).default(0) },
    ({ device_id, cursor }) =>
      invoke(device_id, '/sys/capabilities', 'list', { cursor, limit: 4, details: false }),
  );
  tool(
    'describe_resource',
    'Read the selected resource capability and lifecycle metadata without starting it.',
    { device_id: z.string(), path: z.string() },
    ({ device_id, path }) => invoke(device_id, '/sys/capabilities', 'describe', { path }),
  );
  tool(
    'invoke_resource',
    'Call an advertised resource. For mutations supply a fresh UUID request_id and expected_boot_id from discovery; reuse that identity only to retrieve/reconcile a receipt, never silently replay an uncertain write. Use request/operation completion for asynchronous methods. Large files use discovered chunk limits.',
    {
      device_id: z.string(),
      path: z.string().min(1),
      method: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
      expected_boot_id: z.string().optional(),
      request_id: z
        .string()
        .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
        .optional(),
    },
    ({ device_id, path, method, args, expected_boot_id, request_id }) =>
      invoke(device_id, path, method, args, expected_boot_id, request_id),
  );
  tool(
    'read_operation',
    'Read the server receipt for a previous mutation without repeating it. Native acceptance is separate from physical completion; inspect the declared native completion resource too.',
    { device_id: z.string(), boot_id: z.string(), request_id: z.string() },
    (input) => api('/api/os/receipts/read', input),
  );
  tool(
    'stage_resource',
    'Fetch a large source on the server, or stage generated text. Generated binary files can instead be streamed by execution tools to POST /api/os/artifacts/upload with application/octet-stream and Hub authorization. Returns a job identity immediately; poll read_resource_job for its artifact ID for a managed result files array; never send source URLs to device downloads.',
    {
      url: z.string().url().optional(),
      text: z.string().optional(),
      limit_bytes: z.number().int().positive().optional(),
      request_id: z.string().optional(),
    },
    ({ request_id, ...input }) => api('/api/os/jobs', { kind: 'stage', input, request_id }),
  );
  tool(
    'read_resource_job',
    'Read staging, image preparation or delivery result. Completed staging returns artifact ID; a delivery receipt is not display completion.',
    { id: z.string() },
    (input) => api('/api/os/jobs/read', input),
  );
  tool(
    'cancel_resource_job',
    'Request cancellation of server resource work. It does not roll back a committed device operation.',
    { id: z.string() },
    (input) => api('/api/os/jobs/cancel', input),
  );
  if (options.imagePreparation)
    tool(
      'prepare_image',
      'On the user host, crop/scale an existing artifact to discovered device geometry. Output PNG, RGB8 or palette indices; native panel packing belongs to its adapter. Palette is explicit and must come from discovery.',
      {
        artifact_id: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        fit: z.enum(['contain', 'cover', 'fill']).optional(),
        background: z.string().optional(),
        format: z.enum(['png', 'rgb8', 'indexed8']).optional(),
        palette: z.array(z.tuple([z.number(), z.number(), z.number()])).optional(),
        request_id: z.string().optional(),
      },
      ({ request_id, ...input }) => api('/api/os/jobs', { kind: 'image', input, request_id }),
    );
  tool(
    'deliver_resources',
    'Transfer staged resources in bounded chunks to discovered storage policy. This only delivers a verified bundle; call a resource or return a managed result to use it.',
    {
      device_id: z.string(),
      expected_boot_id: z.string(),
      files: z.array(z.object({ path: z.string(), artifact_id: z.string() })),
      request_id: z.string().optional(),
    },
    ({ request_id, ...input }) => api('/api/os/jobs', { kind: 'deliver', input, request_id }),
  );
  tool(
    'harness_usage',
    'Read usage from the device-bound Harness when its adapter supports it.',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/usage`),
  );
  tool(
    'harness_tools',
    'Read the tools available to the bound Harness session.',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/tools`),
  );
  return server;
}
