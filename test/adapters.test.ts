import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { RpcProcess } from '../src/adapters/rpc.js';
import { CodexAdapter } from '../src/adapters/codex.js';
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

test('Codex catalog uses metadata/summary RPCs without resuming or starting a turn', async () => {
  const { EventEmitter } = await import('node:events');
  const calls: { method: string; params: any }[] = [];
  const wire = Object.assign(new EventEmitter(), {
    write() {},
    async close() {},
    async request(method: string, params: any) {
      calls.push({ method, params });
      if (method === 'initialize') return {};
      if (method === 'thread/list')
        return {
          data: [{ id: 'existing', name: '标题', preview: '原生摘要' }],
          nextCursor: 'native-cursor',
        };
      if (method === 'thread/read')
        return { thread: { id: params.threadId, name: '', ephemeral: true } };
      if (method === 'thread/turns/list')
        return {
          data: [
            {
              startedAt: 10,
              completedAt: 20,
              items: [
                {
                  id: 'user',
                  type: 'userMessage',
                  content: [
                    { type: 'text', text: '问题' },
                    { type: 'image', url: 'not included' },
                  ],
                },
                { id: 'reasoning', type: 'reasoning', text: 'secret' },
                { id: 'tool', type: 'commandExecution', text: 'tool body' },
                { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'progress' },
                { id: 'final', type: 'agentMessage', phase: 'final_answer', text: '结果' },
              ],
            },
          ],
          nextCursor: null,
        };
      throw Error('unexpected native effect: ' + method);
    },
  });
  const a = new CodexAdapter(wire as unknown as RpcProcess);
  try {
    const page = await a.listSessions({ limit: 3 });
    assert.equal(page.entries[0].title, '标题');
    assert.equal(page.next_cursor, 'native-cursor');
    assert.equal((await a.readSession('existing')).title, '');
    const messages = await a.listMessages('existing', { limit: 1, cursor: 'older' });
    assert.deepEqual(
      messages.entries.map((m) => [m.id, m.role, m.text]),
      [
        ['final', 'assistant', '结果'],
        ['user', 'user', '问题'],
      ],
    );
    assert(messages.entries.every((m) => m.preview));
    assert.deepEqual(
      calls.filter((c) => c.method !== 'initialize'),
      [
        { method: 'thread/list', params: { limit: 3, archived: false, modelProviders: [] } },
        { method: 'thread/read', params: { threadId: 'existing', includeTurns: false } },
        {
          method: 'thread/turns/list',
          params: {
            threadId: 'existing',
            limit: 1,
            cursor: 'older',
            itemsView: 'summary',
            sortDirection: 'desc',
          },
        },
      ],
    );
  } finally {
    await a.close();
  }
});

test('Codex refuses a different resumed identity instead of silently retargeting the conversation', async () => {
  const { EventEmitter } = await import('node:events');
  const calls: string[] = [];
  const wire = Object.assign(new EventEmitter(), {
    write() {},
    async close() {},
    async request(method: string) {
      calls.push(method);
      return method === 'initialize' ? {} : { thread: { id: 'different' } };
    },
  });
  const a = new CodexAdapter(wire as unknown as RpcProcess);
  try {
    await assert.rejects(a.open('requested'), /harness_session_identity/);
    assert.deepEqual(calls, ['initialize', 'thread/resume']);
  } finally {
    await a.close();
  }
});
