import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import { deflateSync } from 'node:zlib';
import { imageFromUrl } from '../src/image-source.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { crc32, validRaster } from '../src/raster.js';

function pngImage(width = 1, height = 1, noisy = false) {
  const chunk = (name: string, data: Buffer) => {
    const b = Buffer.alloc(data.length + 12);
    b.writeUInt32BE(data.length);
    b.write(name, 4);
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, b.length - 4)), b.length - 4);
    return b;
  };
  const h = Buffer.alloc(13);
  h.writeUInt32BE(width);
  h.writeUInt32BE(height, 4);
  h[8] = 8;
  h[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  const colors = [
    [0, 0, 0],
    [255, 255, 255],
    [255, 255, 0],
    [255, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
  ];
  let seed = 42;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const color = colors[noisy ? (seed >>> 8) % 6 : 1]!;
      for (let c = 0; c < 3; c++) pixels[y * (width * 3 + 1) + 1 + x * 3 + c] = color[c]!;
    }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', h),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('Image URL follows relative redirects and bounds response size, time, errors and protocols', async () => {
  const png = pngImage();
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/image' });
      res.end();
    } else if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    } else if (req.url === '/slow') {
      /* overall deadline must abort */
    } else if (req.url === '/missing') {
      res.writeHead(404);
      res.end();
    } else if (req.url === '/large') {
      res.writeHead(200);
      res.write(Buffer.alloc(100));
      res.end(Buffer.alloc(100));
    } else {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      res.end(png);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.deepEqual(await imageFromUrl(origin + '/redirect'), png);
    await assert.rejects(imageFromUrl(origin + '/image', { maxBytes: 10 }), /size limit/);
    await assert.rejects(imageFromUrl(origin + '/large', { maxBytes: 120 }), /size limit/);
    await assert.rejects(imageFromUrl(origin + '/missing'), /404/);
    await assert.rejects(imageFromUrl(origin + '/loop'), /redirect limit/);
    await assert.rejects(imageFromUrl(origin + '/slow', { timeoutMs: 50 }), /timed out/);
    await assert.rejects(imageFromUrl('file:///tmp/photo.png'), /HTTP/);
    await assert.rejects(imageFromUrl('https://user:secret@example.com/image.png'), /credentials/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Image downloads use an explicitly configured CONNECT proxy without forwarding account credentials', async () => {
  const png = pngImage();
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.end(png);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  let target = '';
  const proxy = createServer();
  const sockets = new Set<any>();
  proxy.on('connect', (req, client, head) => {
    target = req.url!;
    sockets.add(client);
    const tunnel = connect((upstream.address() as any).port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) tunnel.write(head);
      tunnel.pipe(client);
      client.pipe(tunnel);
    });
    sockets.add(tunnel);
    tunnel.on('error', () => client.destroy());
    client.on('error', () => tunnel.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    assert.deepEqual(
      await imageFromUrl('http://image.invalid/photo.png', {
        proxy: `http://127.0.0.1:${(proxy.address() as any).port}`,
      }),
      png,
    );
    assert.equal(target, 'image.invalid:80');
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  }
});

test('MCP image URL produces a valid native raster; HTML and ambiguous sources never queue commands', async () => {
  const png = pngImage();
  const noisy = pngImage(480, 720, true);
  const source = createServer((req, res) =>
    res.end(
      req.url === '/image' ? png : req.url === '/noisy' ? noisy : '<html>not an image</html>',
    ),
  );
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const origin = `http://127.0.0.1:${(source.address() as any).port}`;
  const store = new Store(':memory:');
  const hub = new Hub({
    store,
    adminToken: '',
    allowPowerCommands: false,
    devices: [{ id: 'board', token: '', adapter: new MockAdapter() }],
  });
  const address = (await hub.listen(0, '127.0.0.1')) as any;
  const client = new Client({ name: 'image-source-test', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)),
    );
    const inspected: any = await client.callTool({
      name: 'inspect_image',
      arguments: { url: origin + '/image' },
    });
    assert.notEqual(inspected.isError, true, JSON.stringify(inspected));
    assert.deepEqual(JSON.parse(inspected.content[0].text).source_size, [1, 1]);
    assert.equal(inspected.content[1].type, 'image');
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM commands').get() as any).n, 0);
    for (const args of [
      { url: origin + '/page' },
      { url: origin + '/image', path: '/tmp/image.png' },
    ]) {
      const response = await client.callTool({
        name: 'present_image',
        arguments: { device_id: 'board', ...args },
      });
      assert.equal(response.isError, true);
      assert.equal((store.db.prepare('SELECT count(*) AS n FROM commands').get() as any).n, 0);
    }
    const response: any = await client.callTool({
      name: 'present_image',
      arguments: { device_id: 'board', url: origin + '/image' },
    });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const command = JSON.parse(response.content[0].text);
    assert.equal(command.status, 'queued');
    assert.equal(command.payload.refresh_profile, 'factory');
    assert.equal(command.rendering.color_mode, 'adaptive');
    assert.equal(command.rendering.photo_tone.saturation_boost, 1);
    assert.ok(validRaster((store.command(command.id)!.payload as any).data));
    const detailed: any = await client.callTool({
      name: 'present_image',
      arguments: { device_id: 'board', url: origin + '/noisy' },
    });
    assert.notEqual(detailed.isError, true, JSON.stringify(detailed));
    const full = JSON.parse(detailed.content[0].text);
    const data = (store.command(full.id)!.payload as any).data;
    assert.ok(Buffer.from(data, 'base64').length > 32768);
    assert.ok(validRaster(data, 180000));
    assert.equal(full.rendering.detail_reduction_factor, 1);
    const manual: any = await client.callTool({
      name: 'present_image',
      arguments: {
        device_id: 'board',
        url: origin + '/noisy',
        refresh_profile: 'fast',
        force: true,
        rendering: { color_mode: 'blue-noise' },
      },
    });
    assert.notEqual(manual.isError, true, JSON.stringify(manual));
    const explicit = JSON.parse(manual.content[0].text);
    assert.equal(explicit.payload.refresh_profile, 'fast');
    assert.equal((store.command(explicit.id)!.payload as any).force, true);
    assert.equal(explicit.rendering.color_mode, 'blue-noise');
    assert.equal(explicit.rendering.photo_tone, null);
    const composed: any = await client.callTool({
      name: 'present_image',
      arguments: {
        device_id: 'board',
        url: origin + '/noisy',
        rendering: { color_mode: 'adaptive', orientation: 'landscape' },
        layout: {
          fit: 'cover',
          crop: { x: 0, y: 0, w: 0.5, h: 1 },
          frame: { x: 20, y: 80, w: 400, h: 300 },
          blocks: [{ x: 24, y: 20, w: 400, h: 60, text: 'Aa 清晰', font_size: 32 }],
        },
      },
    });
    assert.notEqual(composed.isError, true, JSON.stringify(composed));
    const composition = JSON.parse(composed.content[0].text).rendering;
    assert.deepEqual(composition.image_layout.canvas_size, [720, 480]);
    assert.equal(composition.image_layout.text.font_size_is_native, true);
    assert.equal(composition.image_layout.text_dithered, false);
  } finally {
    await client.close();
    await hub.close();
    store.close();
    source.closeAllConnections();
    source.close();
  }
});
