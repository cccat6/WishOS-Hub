import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validRaster } from '../src/raster.js';

test('MCP native text submits only a raster and returns queue state with rendering evidence', async () => {
  let posted: any;
  const mock = createServer(async (req, res) => {
    if (req.method === 'GET') {
      assert.equal(req.url, '/api/devices/test-board/state');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: { max_raster_bytes: 8000 } }));
      return;
    }
    assert.equal(req.url, '/api/devices/test-board/commands');
    assert.equal(req.method, 'POST');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    posted = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'test-queued', status: 'queued' }));
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address() as { port: number };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/mcp.js', import.meta.url))],
    env: {
      PATH: process.env.PATH ?? '',
      NOTES_ADMIN_TOKEN: 'test-only',
      NOTES_HUB_URL: `http://127.0.0.1:${address.port}`,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'native-text-contract-test', version: '1' });
  try {
    await client.connect(transport);
    const reply = await client.callTool({
      name: 'present_text',
      arguments: {
        device_id: 'test-board',
        refresh_profile: 'fast',
        layout: {
          blocks: [
            {
              x: 24,
              y: 24,
              w: 432,
              h: 120,
              text: '清晰文字 Aa 123',
              font_family: 'sarasa',
              font_size: 32,
            },
          ],
        },
      },
    });
    assert.equal(reply.isError, undefined);
    const result = JSON.parse((reply.content as { text: string }[])[0]!.text);
    assert.equal(result.status, 'queued');
    assert.equal(result.rendering.renderer, 'freetype-mono');
    assert.deepEqual(result.rendering.font_families, ['sarasa']);
    assert.deepEqual(Object.keys(posted.payload).sort(), ['data', 'op', 'refresh_profile']);
    assert.equal(posted.payload.op, 'display_rle');
    assert.equal(posted.payload.refresh_profile, 'fast');
    assert.ok(validRaster(posted.payload.data));
  } finally {
    await client.close();
    mock.closeAllConnections();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
});
