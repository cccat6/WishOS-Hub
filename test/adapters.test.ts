import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { RpcProcess } from '../src/adapters/rpc.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { DeepSeekAdapter } from '../src/adapters/deepseek.js';
const fixture = fileURLToPath(new URL('./fixtures/harness.mjs', import.meta.url));
function rpc(kind: string) {
  return new RpcProcess(process.execPath, [fixture, kind], process.cwd(), kind === 'deepseek');
}
test('Codex thread resume, final message, and explicit approval decision', async () => {
  const a = new CodexAdapter(rpc('codex'), 1000);
  try {
    const id = await a.open();
    assert.equal(await a.open(id), id);
    assert.equal(await a.send(id, 'hello', () => {}), 'Codex final');
    assert.equal(
      await a.send(id, 'approve', (e) => {
        if (e.type === 'approval') a.approve(e.requestId!, false);
      }),
      'decision: decline',
    );
  } finally {
    await a.close();
  }
});
test('DeepSeek requires durable admission, tolerates events before RPC receipt', async () => {
  const a = new DeepSeekAdapter(
    rpc('deepseek'),
    { provider: 'fixture', model: 'fixture', cwd: process.cwd() },
    1000,
  );
  try {
    const id = await a.open();
    assert.equal(await a.send(id, 'hello', () => {}), 'DeepSeek final');
    assert.equal(a.capabilities.interrupt, false);
    assert.equal(await a.open(id), id);
  } finally {
    await a.close();
  }
});
test('DeepSeek stale idle cannot count as completion; uncertain runtime is quarantined', async () => {
  const a = new DeepSeekAdapter(rpc('deepseek'), {}, 100);
  try {
    const id = await a.open();
    await assert.rejects(
      a.send(id, 'never-admit', () => {}),
      /timeout/,
    );
    await assert.rejects(a.open(id), /requires restart/);
  } finally {
    await a.close();
  }
});

test('DeepSeek blocked turn is a failure, never a completed response', async () => {
  const a = new DeepSeekAdapter(rpc('deepseek'), {}, 1000);
  try {
    const id = await a.open();
    await assert.rejects(
      a.send(id, 'blocked', () => {}),
      /without completion/,
    );
  } finally {
    await a.close();
  }
});

test('Codex steer waits for native turn admission and uses expectedTurnId; never starts another turn', async () => {
  const a = new CodexAdapter(rpc('codex'), 1000);
  try {
    const id = await a.open();
    const run = a.send(id, 'steer-wait', () => {});
    assert.equal(await a.steer(id, 'use the new instruction'), true);
    assert.equal(await run, 'steered: use the new instruction');
    assert.equal(await a.steer(id, 'after completion'), false);
  } finally {
    await a.close();
  }
});
test('Codex completion race permits continuation; uncertain native steer failure is not replayable', async () => {
  for (const mode of ['steer-ended', 'steer-ended-late', 'steer-error']) {
    const a = new CodexAdapter(rpc('codex'), 1000);
    try {
      const id = await a.open(),
        run = a.send(id, mode, () => {});
      void run.catch(() => {});
      if (mode.startsWith('steer-ended')) {
        assert.equal(await a.steer(id, 'follow-up'), false);
        await run;
      } else {
        await assert.rejects(a.steer(id, 'follow-up'), /uncertain admission error/);
      }
    } finally {
      await a.close();
    }
  }
});
