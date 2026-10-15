import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { validRaster, MAX_STREAM_RASTER_BYTES } from '../src/raster.js';
const raster = createRequire(import.meta.url)('./fixtures/legacy-device-raster.cjs');
let seed = 19;
const pixels = Uint8Array.from({ length: 480 * 720 }, () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return [0, 1, 2, 3, 5, 6][(seed >>> 16) % 6]!;
});
const image = Buffer.from(raster.encode(pixels, 'portrait', 180000));
assert.ok(image.length > 8000);
assert.ok(validRaster(image.toString('base64'), MAX_STREAM_RASTER_BYTES));
async function until(work: () => unknown) {
  for (let n = 0; n < 300; n++) {
    const result = work();
    if (result) return result;
    await delay(10);
  }
  throw Error('test timeout');
}
test('large raster uses ordered bounded WS binary chunks and completed receipts; legacy peer rejects', async () => {
  for (const streaming of [true, false]) {
    const store = new Store(':memory:');
    const hub = new Hub({
      store,
      adminToken: '',
      devices: [{ id: 'board', token: '', adapter: new MockAdapter() }],
    });
    const address = (await hub.listen(0, '127.0.0.1')) as any;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/device?id=board`);
    const chunks: Buffer[] = [];
    let begin: any, end: any;
    try {
      ws.on('message', (raw, binary) => {
        if (binary) {
          assert.ok(raw.length <= 2048);
          chunks.push(Buffer.from(raw as Buffer));
          return;
        }
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'image.begin') begin = msg;
        if (msg.type === 'image.end') {
          end = msg;
          assert.equal(end.command_id, begin.command_id);
          assert.equal(Buffer.concat(chunks).compare(image), 0);
          for (const status of ['accepted', 'running', 'completed'])
            ws.send(JSON.stringify({ type: 'ack', command_id: end.command_id, status }));
        }
      });
      await once(ws, 'open');
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocol: 2,
          device_id: 'board',
          boot_id: 'test-boot',
          capabilities: {
            display: true,
            audio: false,
            sleep: false,
            max_scene_bytes: 8192,
            formats: ['nmp1'],
            max_raster_bytes: 8000,
            streaming_images: streaming,
            max_stream_bytes: 180000,
            refresh_profiles: ['fast'],
          },
        }),
      );
      await until(() => hub.state('board').online);
      const c = hub.enqueue('board', {
        request_id: 'large',
        payload: { op: 'display_rle', data: image.toString('base64'), refresh_profile: 'fast' },
      });
      await until(() => ['completed', 'rejected'].includes(store.command(c.id)!.status));
      assert.equal(store.command(c.id)!.status, streaming ? 'completed' : 'rejected');
      if (streaming) {
        assert.equal(begin.length, image.length);
        assert.equal(begin.crc, image.readUInt32LE(8));
      } else assert.equal(begin, undefined);
    } finally {
      ws.terminate();
      await hub.close();
      store.close();
    }
  }
});
test('passive multipart delivery reconciles lost response without sending image twice', async () => {
  let deliveries = 0;
  const receipts = new Map<string, any>();
  const device = createServer(async (req, res) => {
    if (req.url === '/api/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          device: {
            device_id: 'board',
            boot_id: 'passive-boot',
            state: { display: { hardware_enabled: true }, power: { opt: 0 } },
          },
        }),
      );
      return;
    }
    if (req.url === '/api/info') {
      res.end(JSON.stringify({ research: true }));
      return;
    }
    if (req.url?.startsWith('/v2/receipt?id=')) {
      const id = new URL(req.url, 'http://device').searchParams.get('id')!;
      res.end(JSON.stringify(receipts.get(id)));
      return;
    }
    if (req.url === '/v2/display') {
      deliveries++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request('http://fixture', {
        method: 'POST',
        headers: { 'Content-Type': req.headers['content-type']! },
        body: Buffer.concat(chunks),
      });
      const form = await request.formData();
      const meta = JSON.parse(form.get('meta') as string);
      const file = form.get('image') as File;
      assert.equal(meta.token, 'passive-fixture');
      assert.equal(meta.length, image.length);
      assert.equal(Buffer.from(await file.arrayBuffer()).compare(image), 0);
      receipts.set(meta.command_id, {
        command_id: meta.command_id,
        status: 'completed',
        detail: 'verified fake device receipt',
      });
      res.destroy();
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((resolve) => device.listen(0, '127.0.0.1', resolve));
  const addr = device.address() as any;
  const store = new Store(':memory:');
  const hub = new Hub({
    store,
    adminToken: '',
    devices: [
      {
        id: 'board',
        token: 'passive-fixture',
        deviceUrl: `http://127.0.0.1:${addr.port}`,
        adapter: new MockAdapter(),
      },
    ],
  });
  await hub.listen(0, '127.0.0.1');
  try {
    const c = hub.enqueue('board', {
      request_id: 'once',
      payload: { op: 'display_rle', data: image.toString('base64') },
    });
    await until(() => store.command(c.id)?.status === 'completed');
    assert.equal(deliveries, 1);
    assert.equal(hub.state('board').online, true);
    assert.equal(hub.state('board').capabilities?.audio, false);
    assert.equal(hub.state('board').capabilities?.sleep, false);
  } finally {
    await hub.close();
    store.close();
    device.closeAllConnections();
    await new Promise<void>((resolve) => device.close(() => resolve()));
  }
});
test('device discovery persists identities but restores them offline', async () => {
  const store = new Store(':memory:');
  let hub = new Hub({ store, adminToken: '', devices: [], discoveryToken: '' });
  const address = (await hub.listen(0, '127.0.0.1')) as any;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/device?id=new-board`);
  try {
    await once(ws, 'open');
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol: 2,
        device_id: 'new-board',
        boot_id: 'one',
        capabilities: { display: true, audio: false, sleep: false, max_scene_bytes: 8192 },
      }),
    );
    ws.send(JSON.stringify({ type: 'state', state: { wifi: { mac: 'fixture' } } }));
    await until(() => store.state('new-board').state);
    ws.terminate();
    await hub.close();
    hub = new Hub({ store, adminToken: '', devices: [], discoveryToken: '' });
    await hub.listen(0, '127.0.0.1');
    assert.equal(hub.state('new-board').online, false);
    assert.equal(hub.state('new-board').state.wifi.mac, 'fixture');
  } finally {
    ws.terminate();
    await hub.close();
    store.close();
  }
});
