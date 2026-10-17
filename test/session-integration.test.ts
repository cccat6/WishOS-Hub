import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SessionControl } from '../src/session-control.js';
import { managedAgentRoute } from '../src/os-agent.js';
import { managedContext, managedRequestScope } from '../src/managed-context.js';
import { ArtifactStore } from '../src/os-artifacts.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';

class Catalog extends MockAdapter {
  reads: string[] = [];
  creates = 0;
  sends = 0;
  async listSessions() {
    return { entries: [{ id: 'previous', title: '之前的对话' }], next_cursor: null };
  }
  async readSession(id: string) {
    this.reads.push(id);
    if (id === 'missing') throw Error('session_not_found');
    return { id, title: '对话' };
  }
  async createSession() {
    this.creates++;
    return { id: 'created', title: '' };
  }
  async send() {
    this.sends++;
    return 'not called';
  }
}
const request = (input: any, instance = 4): any => ({
  id: 1,
  request_id: 'boot:request',
  boot_id: 'boot',
  route: 'wishos.ai',
  payload: {
    format: 'wishos-ai/2',
    input,
    context: {
      current: { application_id: 'voice', instance_id: instance, catalog_revision: 2 },
      launch_origin: { application_id: 'clock', instance_id: 3, catalog_revision: 1 },
    },
  },
});

test('session control traverses managed request/result envelopes without a model turn and respects native budgets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wishos-session-route-'));
  const db = new DatabaseSync(':memory:'),
    service = new SessionControl(db),
    adapter = new Catalog();
  let starts = 0;
  const calls: string[] = [];
  const binding = {
    device_id: 'device',
    runtime_id: 'codex',
    scope: 'profile',
    adapter,
    default_session: 'fixed',
  };
  const route = managedAgentRoute({
    artifacts: new ArtifactStore(db, root),
    rpc: async (path, method) => {
      calls.push(path + ':' + method);
      return {
        ok: true,
        boot_id: 'boot',
        result: {
          result_format: 'wishos-result/2',
          inline_result_limit_bytes: 1536,
          action_limit_bytes: 1024,
        },
      };
    },
    start: () => {
      starts++;
      throw Error('unexpected model');
    },
    status: () => undefined,
    sessionControl: (r, input, fits) => service.invoke(binding, input, r.request_id, fits),
  });
  try {
    for (const input of [
      { kind: 'session_control', operation: 'list', limit: 3 },
      { kind: 'session_control', operation: 'create', operation_id: 'create-once' },
      { kind: 'session_control', operation: 'create', operation_id: 'create-once' },
      {
        kind: 'session_control',
        operation: 'select',
        session_id: 'previous',
        runtime_id: 'codex',
        session_scope: 'profile',
      },
    ]) {
      const reply: any = await route(request(input), new AbortController().signal);
      assert.equal(reply.format, 'wishos-result/2');
      assert.equal(reply.actions.length, 1);
      assert.equal(reply.actions[0].topic, 'session_control');
      assert.equal(reply.actions[0].data.request_id, 'boot:request');
      assert.equal(reply.actions[0].data.ok, true);
      assert(Buffer.byteLength(JSON.stringify(reply)) <= 1536);
    }
    assert.equal(starts, 0);
    assert.equal(adapter.sends, 0);
    assert.equal(adapter.creates, 1);
    assert.equal(binding.default_session, 'fixed');
    assert(calls.every((c) => c === '/sys/capabilities:describe'));
  } finally {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('managed voice receives the same immutable context as text and a different instance has a different steering lane', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wishos-session-context-'));
  const db = new DatabaseSync(':memory:');
  const received: any[] = [],
    inputs: string[] = [];
  const voice = Object.assign(
    async (r: any) => {
      received.push(r);
      return { run_id: 'voice' };
    },
    { admit: async () => {} },
  );
  const route = managedAgentRoute({
    artifacts: new ArtifactStore(db, root),
    voice,
    rpc: async () => ({
      ok: true,
      boot_id: 'boot',
      result: {
        result_format: 'wishos-result/2',
        action_limit_bytes: 1536,
        inline_result_limit_bytes: 1536,
      },
    }),
    start: (_r, text) => {
      inputs.push(text);
      return { id: 'text' };
    },
    status: () => ({ status: 'completed', result: 'done' }),
  });
  try {
    const r = request({
      kind: 'voice',
      recording_id: 'recording',
      session_id: 'previous',
      intent: { effect: 'application_update', target_context: 'launch_origin' },
    });
    await route(r, new AbortController().signal);
    assert.deepEqual(received[0].payload.request_context, managedContext(r));
    assert.equal(received[0].payload.managed_request_id, r.request_id);
    assert.equal(received[0].payload.session_id, 'previous');
    assert.equal(received[0].payload.request_scope, managedRequestScope(r));
    assert.notEqual(managedRequestScope(r), managedRequestScope(request(r.payload.input, 5)));
    const text = request({ ...r.payload.input, kind: 'text', text: '修改当前应用' });
    await route(text, new AbortController().signal);
    assert(inputs[0].includes(JSON.stringify(managedContext(text))));
    assert(inputs[0].endsWith('修改当前应用'));
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP MCP resolves a voice-selected reference and returns an ordered application action without changing the default', async () => {
  const store = new Store(':memory:'),
    adapter = new Catalog();
  store.bind('device', 'catalog', 'stale-learned-default');
  const hub = new Hub({
    store,
    adminToken: '',
    devices: [
      {
        id: 'device',
        token: '',
        adapter,
        runtimeId: 'runner',
        runtimeScope: 'profile',
        sessionId: 'fixed',
      },
    ],
  });
  const address = (await hub.listen(0, '127.0.0.1')) as any;
  const client = new Client({ name: 'session-fixture', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + address.port + '/mcp')),
    );
    const call = async (name: string, args: any) => {
      const r: any = await client.callTool({ name, arguments: { device_id: 'device', ...args } });
      return { result: JSON.parse(r.content[0].text), isError: r.isError };
    };
    const catalog = await call('harness_sessions', { operation: 'list' });
    const ref = catalog.result.entries[0].reference;
    const selected = await call('harness_sessions', { operation: 'select', ...ref });
    const action = selected.result.selection_action;
    assert.deepEqual(action.data.selected_session, ref);
    assert.equal(action.type, 'application');
    assert.equal(action.topic, 'session_control');
    assert.equal(action.wait, 'processed');
    assert.equal(action.data.request_id, undefined);
    assert.equal(hub.state('device').session_id, 'fixed');
    const bad = await call('harness_sessions', {
      operation: 'select',
      ...ref,
      session_scope: 'foreign',
    });
    assert(bad.isError);
    assert.equal(bad.result.error.code, 'session_scope_changed');
    assert.deepEqual(adapter.reads, ['previous']);
    const one = await call('create_harness_session', { operation_id: 'create-once' });
    const two = await call('create_harness_session', { operation_id: 'create-once' });
    assert.deepEqual(one.result.selected_session, two.result.selected_session);
    assert.equal(adapter.creates, 1);
    assert.equal(adapter.sends, 0);
  } finally {
    await client.close();
    await hub.close();
    store.close();
  }
});

test('cached managed delivery rechecks application references for both inline and staged plans before replay', async () => {
  for (const staged of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'wishos-managed-cache-'));
    const db = new DatabaseSync(':memory:'),
      artifacts = new ArtifactStore(db, root);
    let valid = true,
      checks = 0,
      deliveries = 0,
      bytes = 1536;
    const action = {
      type: 'application',
      topic: 'session_control',
      data: {
        format: 'wishos-session-control/1',
        operation: 'select',
        ok: true,
        selected_session: {
          runtime_id: 'runner',
          session_id: 'previous',
          session_scope: 'original',
        },
      },
    };
    const result: any = { format: 'wishos-result/2', actions: [action] };
    if (staged) {
      const file = await artifacts.stage({ text: JSON.stringify(action) + '\n' });
      delete result.actions;
      result.sequence = { path: 'actions.jsonl', format: 'jsonl' };
      result.files = [{ path: 'actions.jsonl', artifact_id: file.id }];
      artifacts.preflight = async () => undefined as any;
      artifacts.deliver = async () => {
        deliveries++;
        return { transfer_id: 1 } as any;
      };
    }
    const route = managedAgentRoute({
      artifacts,
      rpc: async () => ({
        ok: true,
        boot_id: 'boot',
        result: {
          result_format: 'wishos-result/2',
          inline_result_limit_bytes: bytes,
          action_limit_bytes: 1536,
        },
      }),
      start: () => ({ id: 'run' }),
      status: () => ({ status: 'completed', result: JSON.stringify(result) }),
      validateApplicationAction: async () => {
        checks++;
        if (!valid) throw Error('session_scope_changed');
      },
    });
    try {
      const input = request({ text: '切回之前的对话' });
      const first = await route(input, new AbortController().signal);
      assert.equal(checks, 1);
      assert.deepEqual(await route(input, new AbortController().signal), first);
      assert.equal(checks, 2);
      valid = false;
      await assert.rejects(
        Promise.resolve(route(input, new AbortController().signal)),
        /session_scope_changed/,
      );
      assert.equal(checks, 3);
      valid = true;
      bytes = 64;
      await assert.rejects(
        Promise.resolve(route(input, new AbortController().signal)),
        /managed_result_metadata_limit/,
      );
      assert.equal(deliveries, staged ? 1 : 0);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
