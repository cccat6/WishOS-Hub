import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
async function stop(c?: ChildProcess) {
  if (!c || c.exitCode !== null) return;
  const done = once(c, 'exit');
  c.kill('SIGTERM');
  await done;
}
test('documented Hub entrypoint and standalone simulator run end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-startup-'));
  let hub: ChildProcess | undefined, sim: ChildProcess | undefined;
  try {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as any).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const config = join(dir, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        port,
        host: '127.0.0.1',
        database: join(dir, 'db.sqlite'),
        devices: [
          {
            id: 'sim-1',
            protocol: 'notes',
            tokenEnv: 'NOTES_DEVICE_TOKEN',
            harness: { kind: 'mock' },
          },
        ],
      }),
    );
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const env = {
      ...process.env,
      NOTES_CONFIG: config,
      NOTES_ADMIN_TOKEN: randomBytes(24).toString('hex'),
      NOTES_DEVICE_TOKEN: randomBytes(24).toString('hex'),
      NOTES_DEVICE_URL: `ws://127.0.0.1:${port}/device`,
    };
    const api = async (path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}` + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${env.NOTES_ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.ok(r.ok);
      return r.json();
    };
    async function wait(fn: () => Promise<any>) {
      for (let n = 0; n < 200; n++) {
        try {
          const value = await fn();
          if (value) return value;
        } catch {}
        await delay(20);
      }
      throw Error('entrypoint smoke timed out');
    }
    hub = spawn(process.execPath, ['dist/main.js'], {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    hub.stderr?.on('data', (b) => (errors += b));
    await wait(() => api('/healthz'));
    sim = spawn(process.execPath, ['--import', 'tsx', 'tools/simulate.ts'], {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    sim.stderr?.on('data', (b) => (errors += b));
    await wait(async () => {
      const state = await api('/api/devices/sim-1/state');
      return state.online && state.state?.simulated;
    });
    const command = await api('/api/devices/sim-1/commands', {
      request_id: 'startup-page',
      payload: { op: 'builtin', name: 'welcome' },
    });
    await wait(async () => {
      const state = await api('/api/commands/' + command.id);
      return state.status === 'completed' && state.detail.includes('simulated');
    });
    const run = await api('/api/devices/sim-1/messages', {
      request_id: 'startup-message',
      text: 'test',
    });
    await wait(async () => {
      const state = await api('/api/runs/' + run.id);
      return state.status === 'completed' && state.result.includes('MOCK - no model called');
    });
    assert.doesNotMatch(errors, /uncaught|TypeError|Error:/);
  } finally {
    await stop(sim);
    await stop(hub);
    rmSync(dir, { recursive: true, force: true });
  }
});
