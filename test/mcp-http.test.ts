import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
const text = (reply: any) => JSON.parse(reply.content[0].text);
test('HTTP MCP: discovery, tools, resource, offline queue, idempotency and isolated clients', async () => {
  const store = new Store(':memory:');
  const hub = new Hub({
    store,
    adminToken: '',
    devices: [{ id: 'board', token: '', adapter: new MockAdapter() }],
    allowPowerCommands: false,
  });
  const address = (await hub.listen(0, '127.0.0.1')) as any;
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const clients = [
    new Client({ name: 'one', version: '1' }),
    new Client({ name: 'two', version: '1' }),
  ];
  try {
    await Promise.all(
      clients.map((client) => client.connect(new StreamableHTTPClientTransport(new URL(url)))),
    );
    const list = await clients[0]!.listTools();
    assert.ok(list.tools.some((t) => t.name === 'present_text'));
    assert.ok(list.tools.some((t) => t.name === 'get_command_status'));
    assert.match(
      (await clients[0]!.readResource({ uri: 'notes://display-guide' })).contents[0]!
        .text as string,
      /not proof/,
    );
    const state = text(await clients[0]!.callTool({ name: 'list_devices', arguments: {} }));
    assert.equal(state[0].online, false);
    const arguments_ = {
      device_id: 'board',
      request_id: 'same',
      scene: { format: 'scene-v1', background: 1, commands: [] },
    };
    const a = text(await clients[0]!.callTool({ name: 'present', arguments: arguments_ }));
    const b = text(await clients[1]!.callTool({ name: 'present', arguments: arguments_ }));
    assert.equal(a.id, b.id);
    assert.equal(a.status, 'queued');
    assert.equal(
      text(
        await clients[1]!.callTool({ name: 'get_command_status', arguments: { command_id: a.id } }),
      ).status,
      'queued',
    );
    const denied = await clients[0]!.callTool({
      name: 'request_shutdown',
      arguments: { device_id: 'board' },
    });
    assert.equal(denied.isError, true);
    const malformed = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await fetch(url)).status, 405);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await hub.close();
    store.close();
  }
});
test('HTTP MCP uses optional Hub token, rejects wrong token and unsupported browser origin', async () => {
  const store = new Store(':memory:');
  const token = 'mcp-fixture-token';
  const hub = new Hub({
    store,
    adminToken: token,
    devices: [{ id: 'board', token: 'device-fixture', adapter: new MockAdapter() }],
  });
  const address = (await hub.listen(0, '127.0.0.1')) as any,
    url = `http://127.0.0.1:${address.port}/mcp`;
  const client = new Client({ name: 'token-client', version: '1' });
  try {
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Origin: 'http://unrelated.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    assert.equal(
      text(await client.callTool({ name: 'list_devices', arguments: {} }))[0].device_id,
      'board',
    );
  } finally {
    await client.close();
    await hub.close();
    store.close();
  }
});
