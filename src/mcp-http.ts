import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createNotesMcp, type HubApi } from './mcp-tools.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWishosMcp } from './wishos-mcp.js';
import { HttpError } from './protocol.js';
export class NotesMcpHttp {
  private active = new Set<ReturnType<typeof createNotesMcp>>();
  private modern = new Set<ReturnType<typeof createMcpHandler>>();
  async handle(req: IncomingMessage, res: ServerResponse, api: HubApi, legacy = false) {
    if (!legacy) {
      if (this.modern.size >= 16) throw new HttpError(429, 'MCP request capacity reached');
      const handler = createMcpHandler(() => createWishosMcp(api), {
        legacy: 'stateless',
        maxRequestBodySize: 2097152,
        maxSubscriptions: 4,
      });
      this.modern.add(handler);
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
        this.modern.delete(handler);
        await handler.close();
      }
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }
    if (this.active.size >= 16) throw new HttpError(429, 'MCP request capacity reached');
    const server = createNotesMcp(api);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    this.active.add(server);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.active.delete(server);
        void server.close().catch(() => {});
      }
    };
    res.once('close', release);
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      if (Number(req.headers['content-length'] ?? 0) > 2097152)
        throw new HttpError(413, 'MCP request too large');
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2097152) throw new HttpError(413, 'MCP request too large');
        chunks.push(Buffer.from(chunk));
      }
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw new HttpError(400, 'invalid MCP JSON');
      }
      await server.connect(transport);
      await transport.handleRequest(req, res, message);
    } catch (error) {
      release();
      throw error;
    }
  }
  async close() {
    await Promise.allSettled([...this.active].map((server) => server.close()));
    this.active.clear();
    await Promise.allSettled([...this.modern].map((handler) => handler.close()));
    this.modern.clear();
  }
}
