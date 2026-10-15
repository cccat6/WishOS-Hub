import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/adapters/codex.js';
import { RpcProcess } from '../src/adapters/rpc.js';

test('native permission and MCP form requests reach the user and grant only the requested turn scope', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/harness.mjs', import.meta.url));
  const adapter = new CodexAdapter(
    new RpcProcess(process.execPath, [fixture, 'codex'], process.cwd()),
    1000,
  );
  try {
    const id = await adapter.open();
    assert.equal((await adapter.reloadTools()).refresh_requested, true);
    const granted = await adapter.send(id, 'permissions', (e) => {
      if (e.type === 'approval') adapter.approve(e.requestId!, true);
    });
    assert.match(granted, /"permissions":\{"network":\{"enabled":true\}\}/);
    assert.match(granted, /"scope":"turn"/);
    const declined = await adapter.send(id, 'permissions', (e) => {
      if (e.type === 'approval') adapter.approve(e.requestId!, false);
    });
    assert.match(declined, /"permissions":\{\}/);
    const form = await adapter.send(id, 'elicitation', (e) => {
      if (e.type === 'approval') {
        assert.throws(() => adapter.approve(e.requestId!, true), /structured user input/);
        adapter.approve(e.requestId!, true, { endpoint: 'https://example.test' });
      }
    });
    assert.match(form, /"action":"accept"/);
    assert.match(form, /"endpoint":"https:\/\/example.test"/);
    const answer = await adapter.send(id, 'userinput', (e) => {
      if (e.type === 'approval')
        adapter.approve(e.requestId!, true, { answers: { choice: { answers: ['Accept'] } } });
    });
    assert.match(answer, /"choice":\{"answers":\["Accept"\]\}/);
  } finally {
    await adapter.close();
  }
});
