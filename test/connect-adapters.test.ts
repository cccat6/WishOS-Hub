import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AcpAdapter, type AgentRpc } from '../src/adapters/acp.js';
import { RunnerHttpAdapter } from '../src/adapters/runner-http.js';
import { DeviceRoutes } from '../src/connect/routes.js';
import { TransportFailure } from '../src/transport-failure.js';
import { ConnectorConfig } from '../src/connect/config.js';
class RpcFixture extends EventEmitter implements AgentRpc {
  calls: { method: string; params: any }[] = [];
  writes: any[] = [];
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'initialize')
      return { agentCapabilities: { sessionCapabilities: { resume: {} } } };
    if (['session/new', 'session/resume', 'session/load'].includes(method))
      return { sessionId: params.sessionId ?? 'native-session' };
    if (method === 'session/prompt') {
      this.emit('message', {
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'answer' },
          },
        },
      });
      return { stopReason: 'end_turn' };
    }
    return {};
  }
  write(m: any) {
    this.writes.push(m);
  }
  async close() {}
}
test('ACP resumes the exact native session, injects advertised MCP and waits for prompt completion', async () => {
  const rpc = new RpcFixture(),
    a = new AcpAdapter('deepseek', rpc, {
      cwd: '/workspace',
      timeoutMs: 1000,
      resumeMethod: 'session/resume',
      mcpServers: [{ type: 'http', name: 'wishos', url: 'http://localhost/mcp', headers: [] }],
    });
  assert.equal(await a.open('saved-session'), 'saved-session');
  assert.equal(rpc.calls[1]!.method, 'session/resume');
  assert.equal(rpc.calls[1]!.params.mcpServers[0].name, 'wishos');
  assert.equal(await a.send('saved-session', 'hello', () => {}), 'answer');
  await a.close();
});
test('runner continuation keeps session and authorization on the user host', async () => {
  process.env.WISHOS_TEST_RUNNER = 'private-runner-key';
  const calls: any[] = [];
  const a = new RunnerHttpAdapter(
    'hermes',
    { endpoint: 'http://runner.test', authTokenEnv: 'WISHOS_TEST_RUNNER', timeoutMs: 2000 },
    async (input, init) => {
      calls.push({ url: String(input), ...init });
      return Response.json(
        String(input).endsWith('/v1/runs')
          ? { run_id: 'run-1' }
          : { status: 'completed', session_id: 'owned-api-session', output: 'done' },
      );
    },
  );
  const session = await a.open('owned-api-session');
  assert.equal(await a.send(session, 'hello', () => {}), 'done');
  assert.equal(JSON.parse(calls[0].body).session_id, session);
  assert.equal(calls[0].headers.Authorization, 'Bearer private-runner-key');
  assert(calls[0].headers['Idempotency-Key']);
  delete process.env.WISHOS_TEST_RUNNER;
});
test('local queue refusals keep the paired route and do not replay or force a reconnect', async () => {
  const routes = new DeviceRoutes('device');
  let refusal: string | undefined,
    closed = 0,
    relay = 0;
  routes.attach(
    'lan',
    async () => {
      if (refusal) throw new TransportFailure(refusal, false);
      return { boot_id: 'boot', ok: true, result: {} };
    },
    'boot',
    () => {
      closed++;
    },
  );
  routes.attach(
    'relay',
    async () => {
      relay++;
      return { boot_id: 'boot', ok: true, result: {} };
    },
    'boot',
  );
  for (const code of ['rpc_backpressure', 'rpc_queue_timeout', 'rpc_message_limit']) {
    refusal = code;
    await assert.rejects(routes.rpc('/dev/mic', 'read_chunk', {}), new RegExp(code));
    assert.equal(routes.status().route, 'lan');
  }
  refusal = undefined;
  assert((await routes.rpc('/dev/mic', 'read_chunk', {})).ok);
  assert.equal(relay, 0);
  assert.equal(closed, 0);
  routes.close();
});
test('LAN is preferred, failed mutations are not replayed and a new boot is detected', async () => {
  const routes = new DeviceRoutes('device');
  let lan = 0,
    relay = 0;
  routes.attach(
    'relay',
    async () => {
      ++relay;
      return { boot_id: 'boot', ok: true, result: {} };
    },
    'boot',
  );
  routes.attach(
    'lan',
    async () => {
      ++lan;
      throw Error('rpc_outcome_unknown');
    },
    'boot',
  );
  await assert.rejects(routes.rpc('/sys/test', 'write', {}), /outcome_unknown/);
  assert.equal(relay, 0);
  assert.equal((await routes.rpc('/sys/test', 'read', {})).ok, true);
  assert.equal(relay, 1);
  assert.equal(lan, 1);
  routes.attach('lan', async () => ({ boot_id: 'other', ok: true, result: {} }), 'boot');
  await assert.rejects(routes.rpc('/sys/test', 'write', {}), /boot_changed/);
  assert.equal(relay, 1);
  routes.close();
});
test('connector rejects raw model keys and inconsistent bindings before applying configuration', () => {
  const base = {
    format: 'wishos-connector/1',
    id: 'connector',
    cloudRoomId: '12345678-1234-4234-8234-123456789012',
    pairingSeed: 'x'.repeat(43),
    localToken: 'x'.repeat(32),
  };
  assert.throws(() => ConnectorConfig.parse({ ...base, api_key: 'not-accepted' }));
  assert.throws(() =>
    ConnectorConfig.parse({
      ...base,
      devices: [{ id: 'd', label: 'D', token: 'x'.repeat(32), runtimeId: 'missing' }],
    }),
  );
  assert.equal(ConnectorConfig.parse(base).runtimes.length, 0);
});

test('ACP SSE parses CRLF and UTF-8 split at every network byte boundary', async () => {
  const { SseRpc } = await import('../src/adapters/sse-rpc.js');
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const rpc = new SseRpc('https://fixture/acp', 'fixture', async (_url, init) => {
    if (init?.method === 'POST') {
      const request = JSON.parse(String(init.body));
      const bytes = encoder.encode(
        'data: ' + JSON.stringify({ id: request.id, result: { text: '中文' } }) + '\r\n\r\n',
      );
      for (const byte of bytes) stream.enqueue(Uint8Array.of(byte));
      return new Response(null, { status: 202 });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          stream = controller;
          init!.signal!.addEventListener('abort', () => controller.close(), { once: true });
        },
      }),
      { headers: { 'Acp-Connection-Id': 'connection' } },
    );
  });
  try {
    assert.deepEqual(await rpc.request('session/prompt', {}, 500), { text: '中文' });
  } finally {
    await rpc.close();
  }
});

test('native speech discovery accepts the installed desktop package location and keeps explicit version override', async () => {
  const { detectedCodexSpeech } = await import('../src/connect/runtime.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'wishos-desktop-info-')),
    prior = process.env.CODEX_APP_VERSION;
  try {
    delete process.env.CODEX_APP_VERSION;
    const info = join(root, 'Info.plist');
    await writeFile(
      info,
      '<plist><dict><key>CFBundleShortVersionString</key><string>26.1007.30912</string></dict></plist>',
    );
    assert.deepEqual(detectedCodexSpeech([join(root, 'missing.plist'), info]), {
      appVersion: '26.1007.30912',
    });
    process.env.CODEX_APP_VERSION = '26.1016.1';
    assert.deepEqual(detectedCodexSpeech([info]), { appVersion: '26.1016.1' });
  } finally {
    if (prior === undefined) delete process.env.CODEX_APP_VERSION;
    else process.env.CODEX_APP_VERSION = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex approval reviewer is explicit configuration and rejected for an adapter without that implementation', async () => {
  const { RuntimeConfig } = await import('../src/connect/config.js');
  const runtime = { id: 'c', kind: 'codex', label: 'Codex', approvalsReviewer: 'auto_review' };
  assert.equal(RuntimeConfig.parse(runtime).approvalsReviewer, 'auto_review');
  assert.throws(() => RuntimeConfig.parse({ ...runtime, kind: 'cursor' }));
  assert.equal(
    RuntimeConfig.parse({ id: 'c', kind: 'codex', label: 'Codex' }).approvalsReviewer,
    undefined,
  );
});

test('route and boot wrappers preserve host scheduling metadata without changing device arguments', async () => {
  const { bootRpc } = await import('../src/device-files.js');
  const routes = new DeviceRoutes('device');
  const seen: any[] = [];
  routes.attach(
    'lan',
    async (path, method, args, scheduling) => {
      seen.push({ path, method, args, scheduling });
      return { boot_id: 'boot', ok: true, result: {} };
    },
    'boot',
  );
  const rpc = bootRpc(routes.rpc, 'boot');
  await rpc('/services/remote', 'peek', { after_id: 1 }, { priority: 'background' });
  await rpc('/services/remote', 'complete', { id: 1 });
  assert.deepEqual(seen, [
    {
      path: '/services/remote',
      method: 'peek',
      args: { after_id: 1, expected_boot_id: 'boot' },
      scheduling: { priority: 'background' },
    },
    {
      path: '/services/remote',
      method: 'complete',
      args: { id: 1, expected_boot_id: 'boot' },
      scheduling: undefined,
    },
  ]);
  routes.close();
});
