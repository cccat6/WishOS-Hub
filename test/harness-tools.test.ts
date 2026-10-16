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
    const empty = await adapter.send(id, 'empty-elicitation', (e) => {
      if (e.type === 'approval') adapter.approve(e.requestId!, true);
    });
    assert.match(empty, /"action":"accept"/);
    assert.match(empty, /"content":\{\}/);
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

test('new in-memory Codex sessions can list tools without resuming a nonexistent rollout; reset and close release residency', async () => {
  class SessionRpc extends RpcProcess {
    initialized = false;
    durable = false;
    calls: string[] = [];
    constructor() {
      super(process.execPath, [], process.cwd());
    }
    override async request(method: string, _params: unknown) {
      this.calls.push(method);
      if (method === 'initialize') {
        this.initialized = true;
        return {};
      }
      assert(this.initialized);
      if (method === 'thread/start') return { thread: { id: 'memory-thread' } };
      if (method === 'thread/resume') {
        assert(this.durable, 'no rollout found');
        return { thread: { id: 'memory-thread' } };
      }
      if (method === 'mcpServerStatus/list') return { data: [] };
      throw Error('unexpected_method');
    }
    override write() {}
    override async close() {
      this.initialized = false;
      this.emit('closed', Error('closed'));
    }
  }
  const rpc = new SessionRpc(),
    adapter = new CodexAdapter(rpc);
  try {
    const id = await adapter.open();
    await adapter.readTools(id);
    await adapter.open(id);
    assert.equal(rpc.calls.filter((m) => m === 'thread/resume').length, 0);
    rpc.durable = true;
    await rpc.close();
    await adapter.readTools(id);
    assert.equal(rpc.calls.filter((m) => m === 'initialize').length, 2);
    assert.equal(rpc.calls.filter((m) => m === 'thread/resume').length, 1);
    await adapter.close();
    const before = rpc.calls.length;
    await assert.rejects(adapter.readTools(id), /adapter closed/);
    await assert.rejects(
      adapter.send(id, 'late input', () => {}),
      /adapter closed/,
    );
    assert.equal(rpc.calls.length, before);
  } finally {
    await adapter.close();
  }
});
