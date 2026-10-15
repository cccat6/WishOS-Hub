import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { codexUsage } from '../src/adapters/usage.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { RpcProcess } from '../src/adapters/rpc.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { Store } from '../src/store.js';
import { Hub } from '../src/hub.js';

test('quota windows use consumed percentages, prefer per-limit data and keep credits separate from money', () => {
  const r = codexUsage(
    {
      accountId: 'private-id',
      token: 'private-token',
      rateLimitResetCredits: { credits: [{ id: 'private-reset' }] },
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 12.5, windowDurationMins: 10080, resetsAt: 1800000000 },
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance: '12345.678900' },
        },
      },
    },
    '2026-10-04T00:00:00Z',
  );
  assert.equal(r.available, true);
  assert.equal(r.limits?.[0]?.primary?.remaining_percent, 87.5);
  assert.equal(r.limits?.[0]?.secondary, null);
  assert.equal(r.limits?.[0]?.credits?.balance, '12345.678900');
  assert.equal(r.limits?.[0]?.credits?.unit, 'credits');
  assert.equal(r.limits?.[0]?.credits?.currency, null);
  assert.doesNotMatch(JSON.stringify(r), /private-/);
  const unknown = codexUsage({ rateLimits: { primary: { windowDurationMins: 300 } } });
  assert.equal(unknown.limits?.[0]?.primary?.remaining_percent, null);
  assert.equal(codexUsage({}).available, false);
});
test('native Codex usage works through WishOS HTTP MCP while unsupported adapters return explicit unavailable', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/harness.mjs', import.meta.url));
  const adapter = new CodexAdapter(
    new RpcProcess(process.execPath, [fixture, 'codex'], process.cwd()),
  );
  const store = new Store(':memory:');
  const hub = new Hub({
    store,
    adminToken: '',
    devices: [
      { id: 'board', token: '', adapter },
      { id: 'unsupported', token: '', adapter: new MockAdapter() },
    ],
  });
  const client = new Client({ name: 'usage-test', version: '1' });
  try {
    const address = (await hub.listen(0, '127.0.0.1')) as any;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)),
    );
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'harness_usage'));
    const result: any = await client.callTool({
      name: 'harness_usage',
      arguments: { device_id: 'board' },
    });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.source, 'account/rateLimits/read');
    assert.equal(data.limits[0].primary.remaining_percent, 75);
    assert.equal(data.limits[0].credits.balance, '123.456');
    const unavailable: any = await client.callTool({
      name: 'harness_usage',
      arguments: { device_id: 'unsupported' },
    });
    assert.equal(JSON.parse(unavailable.content[0].text).available, false);
    assert.equal(await adapter.open(), 'thread-1');
    assert.equal(await adapter.send('thread-1', 'hello', () => {}), 'Codex final');
  } finally {
    await client.close();
    await hub.close();
    store.close();
  }
});
