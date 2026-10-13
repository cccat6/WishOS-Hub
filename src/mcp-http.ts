import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createNotesMcp, type HubApi } from './mcp-tools.js';
import { HttpError } from './protocol.js';
export class NotesMcpHttp {
  private active = new Set<ReturnType<typeof createNotesMcp>>();
  async handle(req: IncomingMessage, res: ServerResponse, api: HubApi) {
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
  }
}
