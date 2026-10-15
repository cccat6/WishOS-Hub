import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWishosMcp } from './wishos-mcp.js';
import { HttpError } from './protocol.js';
import type { HubApi } from './api-types.js';
/** One protocol surface; compatibility is negotiated by the same MCP SDK. */
export class McpHttp {
  private active = new Set<ReturnType<typeof createMcpHandler>>();
  async handle(req: IncomingMessage, res: ServerResponse, api: HubApi) {
    if (this.active.size >= 16) throw new HttpError(429, 'MCP request capacity reached');
    const handler = createMcpHandler(() => createWishosMcp(api), {
      legacy: 'stateless',
      maxRequestBodySize: 2097152,
      maxSubscriptions: 4,
    });
    this.active.add(handler);
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const request = new Request(
        new URL(req.url ?? '/mcp', 'http://' + (req.headers.host ?? 'localhost')),
        {
          method: req.method,
          headers: Object.entries(req.headers).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, Array.isArray(value) ? value.join(',') : value]],
          ),
          ...(req.method === 'GET' || req.method === 'HEAD'
            ? {}
            : { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' }),
          signal: abort.signal,
        } as RequestInit,
      );
      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as any), res);
      else res.end();
    } finally {
      this.active.delete(handler);
      await handler.close();
    }
  }
  async close() {
    await Promise.allSettled([...this.active].map((handler) => handler.close()));
    this.active.clear();
  }
}
