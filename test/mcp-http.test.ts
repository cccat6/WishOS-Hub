import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
const text = (reply: any) => JSON.parse(reply.content[0].text);
test('HTTP MCP: tools, guidance, offline errors and isolated clients', async () => {
  const store = new Store(':memory:');
  const hub = new Hub({
    store,
    adminToken: '',
    devices: [{ id: 'board', token: '', adapter: new MockAdapter() }],
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
    assert.ok(list.tools.some((t) => t.name === 'invoke_resource'));
    assert.ok(!list.tools.some((t) => t.name === 'present_text'));
    assert.match(
      (await clients[0]!.readResource({ uri: 'wishos://guidance/components' })).contents[0]!
        .text as string,
      /wishos-components/,
    );
    for (const client of clients) {
      assert.equal(
        text(await client.callTool({ name: 'list_devices', arguments: {} }))[0].online,
        false,
      );
      const unavailable = await client.callTool({
        name: 'discover_resources',
        arguments: { device_id: 'board' },
      });
      assert.equal(unavailable.isError, true);
    }
    const malformed = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
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
