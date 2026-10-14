import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

// Independent entrypoint for the public resource ABI. The existing Hub's
// v2 websocket protocol stays intact until its device adapter is migrated.
export function createHardwareMcp(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  options: { deviceId?: string; token?: string } = {},
) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw Error('HTTP device URL required');
  let expectedBoot: string | undefined;
  async function invoke(
    path: string,
    method: string,
    args: Record<string, unknown>,
    requestId?: string,
    discoveryBoot?: string | null,
  ) {
    const guard = discoveryBoot === null ? undefined : (discoveryBoot ?? expectedBoot);
    const body = JSON.stringify({
      id: requestId ?? randomUUID(),
      path,
      method,
      args,
      ...(guard ? { expected_boot_id: guard } : {}),
    });
    if (Buffer.byteLength(body) > 4096)
      throw Error('Device request exceeds 4096 bytes; use chunked I/O');
    const response = await fetcher(
      new URL(
        options.deviceId
          ? `/api/os/devices/${encodeURIComponent(options.deviceId)}/invoke`
          : '/os/invoke',
        base,
      ),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(10000),
      },
    );
    const text = await response.text();
    if (Buffer.byteLength(text) > 32768) throw Error('Device response exceeds limit');
    let reply: { ok?: boolean; boot_id?: string };
    try {
      reply = JSON.parse(text) as typeof reply;
    } catch {
      throw Error('Non-JSON device response');
    }
    if (reply.ok && discoveryBoot === undefined && !expectedBoot) expectedBoot = reply.boot_id;
    return { content: [{ type: 'text' as const, text }], isError: !response.ok || !reply.ok };
  }
  const server = new McpServer(
    { name: 'agentic-notes-hardware', version: '1.0.0' },
    {
      instructions:
        'Discover /sys/capabilities and /sys/board first. Read immutable hardware constraints separately from configurable policies. Invoke advertised methods, inspect queued job IDs and /sys/jobs or /sys/events for completion. Use /sys/config, /sys/stats and /sys/storage when advertised. Hardware facts and policy defaults differ; never assume a specific button count, network technology or storage medium. Respect the current display driver readiness constraint. Read the agentic-notes-hardware skill for ordering and limits. No retry of timed-out mutations without checking state.',
    },
  );
  server.tool(
    'hardware_discover',
    'Read the live resource catalog and board constraints.',
    {},
    async () => {
      const content: { type: 'text'; text: string }[] = [];
      let cursor = 0,
        boot: string | undefined;
      for (let page = 0; page < 16; page++) {
        const catalog = await invoke(
          '/sys/capabilities',
          'list',
          { cursor, limit: 4, details: true },
          undefined,
          boot ?? null,
        );
        content.push(...catalog.content);
        if (catalog.isError) return { content, isError: true };
        const reply = JSON.parse(catalog.content[0]!.text);
        if (boot && reply.boot_id !== boot) throw Error('Device rebooted during discovery');
        boot = reply.boot_id;
        if (!reply.result?.more) break;
        const next = reply.result.next_cursor;
        if (!Number.isInteger(next) || next <= cursor) throw Error('Invalid discovery cursor');
        cursor = next;
        if (page === 15) throw Error('Discovery exceeded bounded page count');
      }
      const board = await invoke('/sys/board', 'read', {}, undefined, boot ?? null);
      content.push(...board.content);
      const boardReply = JSON.parse(board.content[0]!.text);
      if (boot && boardReply.boot_id !== boot) throw Error('Device rebooted during discovery');
      if (!board.isError) expectedBoot = boardReply.boot_id;
      return { content, isError: board.isError };
    },
  );
  server.tool(
    'hardware_invoke',
    'Call a discovered hardware resource method. Large data uses 1024 byte chunks; queued is not completed.',
    {
      path: z.string().min(1).max(48),
      method: z.string().min(1).max(32),
      args: z.record(z.unknown()).default({}),
      request_id: z.string().min(1).max(64).optional(),
    },
    ({ path, method, args, request_id }) => invoke(path, method, args, request_id),
  );
  return server;
}
if (process.argv[1]?.endsWith('hardware-mcp.js')) {
  const endpoint = process.env.NOTES_OS_URL;
  if (!endpoint) throw Error('Set NOTES_OS_URL to the new board HTTP address');
  await createHardwareMcp(endpoint, fetch, {
    deviceId: process.env.NOTES_DEVICE_ID,
    token: process.env.NOTES_HUB_TOKEN,
  }).connect(new StdioServerTransport());
}
