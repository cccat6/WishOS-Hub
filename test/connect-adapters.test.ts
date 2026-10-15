import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AcpAdapter, type AgentRpc } from '../src/adapters/acp.js';
import { RunnerHttpAdapter } from '../src/adapters/runner-http.js';
import { DeviceRoutes } from '../src/connect/routes.js';
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
