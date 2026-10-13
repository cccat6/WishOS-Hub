import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { codexThreadOptions } from '../src/adapters/codex-options.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { RpcProcess } from '../src/adapters/rpc.js';

test('Notes configuration preserves arbitrary configured servers, host settings and instructions', () => {
  const options = codexThreadOptions(
    '/project',
    'http://127.0.0.1:8787/mcp',
    'TOKEN',
    'Notes instructions',
    {
      model: 'existing-model',
      developerInstructions: 'User custom workflow',
      config: {
        approval_policy: 'on-request',
        mcp_servers: {
          custom_calendar: { command: 'existing-server', args: ['run'] },
          agentic_notes: { tool_timeout_sec: 99 },
        },
      },
    },
  );
  assert.equal(options.model, 'existing-model');
  assert.equal(options.config.approval_policy, 'on-request');
  assert.deepEqual(options.config.mcp_servers.custom_calendar, {
    command: 'existing-server',
    args: ['run'],
  });
  assert.equal(options.config.mcp_servers.agentic_notes.url, 'http://127.0.0.1:8787/mcp');
  assert.equal(options.config.mcp_servers.agentic_notes.tool_timeout_sec, 99);
  assert.equal(options.config.mcp_servers.agentic_notes.enabled_tools, undefined);
  assert.match(options.developerInstructions, /User custom workflow/);
  assert.match(options.developerInstructions, /explicit user authorization/);
  assert.doesNotMatch(options.developerInstructions, /Do not inspect project files/);
});

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
