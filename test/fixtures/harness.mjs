import readline from 'node:readline';
const kind = process.argv[2];
let count = 0,
  held;
const output = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line),
    p = m.params ?? {};
  const reply = (result) => output({ id: m.id, result });
  if (m.method === 'initialize') {
    reply({ protocolVersion: '0.0.1' });
    return;
  }
  if (kind === 'codex') {
    if (m.method === 'config/mcpServer/reload') return reply({});
    if (m.method === 'account/rateLimits/read')
      return reply({
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 1800000000 },
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance: '123.456' },
        },
      });
    if (m.method === 'thread/start' || m.method === 'thread/resume')
      return reply({ thread: { id: p.threadId ?? 'thread-1' } });
    if (m.method === 'turn/steer') {
      if (
        !held ||
        p.threadId !== held.threadId ||
        p.expectedTurnId !== held.id ||
        p.input?.[0]?.type !== 'text'
      )
        return output({ id: m.id, error: { code: -32600, message: 'expectedTurnId mismatch' } });
      if (held.mode === 'steer-error')
        return output({ id: m.id, error: { code: -32603, message: 'uncertain admission error' } });
      if (held.mode === 'steer-ended' || held.mode === 'steer-ended-late') {
        if (held.mode === 'steer-ended-late') {
          const completed = held;
          held = undefined;
          output({ id: m.id, error: { code: -32600, message: 'no active turn' } });
          setTimeout(
            () =>
              output({
                method: 'turn/completed',
                params: {
                  threadId: completed.threadId,
                  turn: { id: completed.id, status: 'completed' },
                },
              }),
            30,
          );
          return;
        }
        output({
          method: 'turn/completed',
          params: { threadId: held.threadId, turn: { id: held.id, status: 'completed' } },
        });
        held = undefined;
        return output({ id: m.id, error: { code: -32600, message: 'no active turn' } });
      }
      reply({ turnId: held.id });
      output({
        method: 'item/completed',
        params: {
          threadId: held.threadId,
          turnId: held.id,
          item: { type: 'agentMessage', text: 'steered: ' + p.input[0].text },
        },
      });
      output({
        method: 'turn/completed',
        params: { threadId: held.threadId, turn: { id: held.id, status: 'completed' } },
      });
      held = undefined;
      return;
    }
    if (m.method === 'turn/interrupt') return reply({});
    if (m.method === 'turn/start') {
      const threadId = p.threadId,
        id = 'turn-' + ++count;
      output({ method: 'turn/started', params: { threadId, turn: { id } } });
      if (p.input[0].text.startsWith('steer-')) {
        held = { threadId, id, mode: p.input[0].text };
        setTimeout(() => reply({ turn: { id } }), 30);
        return;
      }
      reply({ turn: { id } });
      const requests = {
        permissions: {
          method: 'item/permissions/requestApproval',
          permissions: { network: { enabled: true } },
        },
        'empty-elicitation': {
          method: 'mcpServer/elicitation/request',
          mode: 'form',
          requestedSchema: { type: 'object', properties: {} },
        },
        elicitation: {
          method: 'mcpServer/elicitation/request',
          mode: 'form',
          requestedSchema: { type: 'object', required: ['endpoint'] },
        },
        userinput: {
          method: 'item/tool/requestUserInput',
          questions: [{ id: 'choice', question: 'Connect new tool?' }],
        },
      };
      const special = requests[p.input[0].text];
      if (special) {
        const { method, ...fields } = special;
        return output({ id: 999, method, params: { threadId, turnId: id, ...fields } });
      }
      if (p.input[0].text === 'approve')
        return output({
          id: 999,
          method: 'item/commandExecution/requestApproval',
          params: { threadId, turnId: id, command: 'echo test' },
        });
      output({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId: id, delta: 'partial' },
      });
      output({
        method: 'item/completed',
        params: { threadId, turnId: id, item: { type: 'agentMessage', text: 'Codex final' } },
      });
      output({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } });
    } else if (m.id === 999) {
      output({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-' + count,
          item: {
            type: 'agentMessage',
            text: 'decision: ' + (m.result.decision ?? JSON.stringify(m.result)),
          },
        },
      });
      output({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-' + count, status: 'completed' } },
      });
    }
  }
});
