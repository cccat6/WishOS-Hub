import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HubApi } from './mcp-tools.js';
/** Model-facing integration for the portable resource ABI. No device geometry,
 * palette, application page or physical refresh sequence is defined here. */
export function createWishosMcp(api: HubApi) {
  const server = new McpServer(
    { name: 'wishos', version: '1.0.0' },
    {
      instructions:
        'Discover the selected device and resource capabilities first. Use /sys/apps for installed package references and lifecycle, and inspect the selected default package source as a hardware-specific reference. The launcher is an ordinary replaceable application. Preserve the independent /sys/navigation home/voice entry; explain controls, first-use guidance, help and task feedback when creating or changing an application. Do not introduce active/passive user work modes. Hardware drivers are compiled; UI, pages, input meanings and application behavior are ordinary runtime packages that can be replaced without firmware changes. UI layout, font/image rendering and presentation are system services; applications provide descriptions and behavior. Applications use /services/ai for managed AI requests with application/system/both targets; never implement provider or Harness protocols inside an app. The system processes wishos-result/1 results and coordinates replacement after notifying the origin. Stage large files/code/images on the Hub with stage_resource; do not send arbitrary source download URLs to the device. Inspect /sys/transfers storage policy, physical partitions, quotas and runtime parser budgets. Pre-extract large JSON/XML and index books upstream. Use a presentation effect for UI-only output. Inspect /sys/ui capabilities and a device-provided UI example before generating its document format. Logs and telemetry are separate system services; never include prompts, credentials, audio or arbitrary log text in telemetry. Use advertised resource calls and file paths, never GPIO/register access. Keep deterministic work local; use a remote route only for an explicit application action. An accepted request is not physical completion: inspect its completion/event receipt. A timed-out mutation must be reconciled before retry. Display drivers declare their own colors, geometry and completion models; never infer them from the MCU or a previous device. Recordings are compressed blocks; durable upload, speech recognition, Harness admission and displayed output are separate stages. Use the existing Harness session tools for the user task, then explicitly present the result through the device resources.',
    },
  );
  const invoke = async (
    device: string,
    path: string,
    method: string,
    args: Record<string, unknown>,
    boot?: string,
  ) => {
    const reply = await api(`/api/os/devices/${encodeURIComponent(device)}/invoke`, {
      path,
      method,
      args,
      ...(boot ? { expected_boot_id: boot } : {}),
    });
    return { ...reply, isError: JSON.parse(reply.content[0]!.text).ok === false };
  };
  server.tool('list_devices', 'List connected devices and their transport state.', {}, () =>
    api('/api/devices'),
  );
  server.tool(
    'device_state',
    'Read device, Harness and connection state.',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/state`),
  );
  server.tool(
    'discover_resources',
    'Read one page of the live resource catalog. Continue while more is true; detailed method schemas are read separately.',
    { device_id: z.string(), cursor: z.number().int().min(0).default(0) },
    ({ device_id, cursor }) =>
      invoke(device_id, '/sys/capabilities', 'list', { cursor, limit: 4, details: false }),
  );
  server.tool(
    'describe_resource',
    'Read the selected resource capability and lifecycle metadata without starting it.',
    { device_id: z.string(), path: z.string() },
    ({ device_id, path }) => invoke(device_id, '/sys/capabilities', 'describe', { path }),
  );
  server.tool(
    'invoke_resource',
    'Call an advertised system, device, file or application service. Use request/operation completion for asynchronous methods. Large files use discovered chunk limits.',
    {
      device_id: z.string(),
      path: z.string().min(1),
      method: z.string().min(1),
      args: z.record(z.unknown()).default({}),
      expected_boot_id: z.string().optional(),
    },
    ({ device_id, path, method, args, expected_boot_id }) =>
      invoke(device_id, path, method, args, expected_boot_id),
  );
  server.tool(
    'stage_resource',
    'Fetch a large source on the server, or stage generated text. Generated binary files can instead be streamed by execution tools to POST /api/os/artifacts/upload with application/octet-stream and Hub authorization. Return its artifact ID for a managed result files array; never send source URLs to device downloads.',
    {
      url: z.string().url().optional(),
      text: z.string().optional(),
      limit_bytes: z.number().int().positive().optional(),
    },
    (input) => api('/api/os/artifacts', input),
  );
  server.tool(
    'harness_usage',
    'Read usage from the device-bound Harness when its adapter supports it.',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/usage`),
  );
  server.tool(
    'harness_tools',
    'Read the tools available to the bound Harness session.',
    { device_id: z.string() },
    ({ device_id }) => api(`/api/devices/${encodeURIComponent(device_id)}/tools`),
  );
  return server;
}
