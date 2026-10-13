import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { once } from 'node:events';
import { CodexDictation, pcm16Mono } from '../src/adapters/codex-dictation.js';
import { AudioStream } from '../src/voice.js';
function wave() {
  const stream = new AudioStream('test');
  const frame = Buffer.alloc(1285);
  frame[0] = 0x41;
  stream.append(frame);
  return stream.finish(1, true);
}
test('native dictation honors handshake, PCM order, final revisions, closure, cancellation and incomplete streams', async () => {
  for (const mode of ['success', 'premature', 'cancel']) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const port = (server.address() as any).port;
    const received: string[] = [];
    const controller = new AbortController();
    server.on('connection', (ws) =>
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        received.push(m.type);
        if (m.type === 'session.start') {
          assert.equal(m.config.sample_rate_hz, 16000);
          assert.equal(m.config.language, 'zh');
          ws.send(JSON.stringify({ type: 'session.started' }));
        }
        if (m.type === 'audio.append')
          assert.equal(Buffer.from(m.audio, 'base64').compare(pcm16Mono(wave())), 0);
        if (m.type === 'session.close') {
          if (mode === 'premature') {
            ws.close();
            return;
          }
          if (mode === 'cancel') {
            controller.abort();
            return;
          }
          ws.send(
            JSON.stringify({
              type: 'transcript.delta',
              utterance_id: 'a',
              revision: 1,
              text: 'partial',
            }),
          );
          ws.send(
            JSON.stringify({
              type: 'transcript.final',
              utterance_id: 'a',
              revision: 2,
              text: '语音测试成功',
            }),
          );
          ws.send(
            JSON.stringify({
              type: 'transcript.final',
              utterance_id: 'a',
              revision: 1,
              text: 'old',
            }),
          );
          ws.send(JSON.stringify({ type: 'session.updated', session: { status: 'closed' } }));
        }
      }),
    );
    const native = new CodexDictation(
      async () => ({
        token: 'test-token',
        accountId: 'test-account',
        backendOrigin: 'https://chatgpt.com',
        routingOverride: 'NO_CONSTRAINT',
      }),
      { appVersion: '26.930.21537' },
      (url, protocols, options) => {
        assert.match(url, /dictation\/stream/);
        assert.deepEqual(protocols, ['chatgpt-dictation', 'codex-desktop']);
        const h = options.headers as Record<string, string>;
        assert.equal(h.Authorization, 'Bearer test-token');
        assert.equal(h.originator, 'Codex Desktop');
        assert.match(h['User-Agent']!, /^Codex Desktop\//);
        return new WebSocket(`ws://127.0.0.1:${port}`);
      },
    );
    try {
      const work = native.transcribe(wave(), { sessionId: 'selected', signal: controller.signal });
      if (mode === 'success') {
        assert.equal(await work, '语音测试成功');
        assert.deepEqual(received, ['session.start', 'audio.append', 'session.close']);
      } else await assert.rejects(work, mode === 'cancel' ? /cancelled/ : /before final/);
    } finally {
      for (const ws of server.clients) ws.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});
test('invalid audio and unrecognized routing fail before sending credentials', async () => {
  let connected = false;
  const recognizer = new CodexDictation(
    async () => ({
      token: 'secret',
      accountId: 'account',
      backendOrigin: 'https://unrelated.example',
      routingOverride: 'NO_CONSTRAINT',
    }),
    { appVersion: '1' },
    () => {
      connected = true;
      throw Error('must not connect');
    },
  );
  await assert.rejects(
    recognizer.transcribe(wave(), { sessionId: null, signal: new AbortController().signal }),
    /routing/,
  );
  await assert.rejects(
    recognizer.transcribe(Buffer.from('bad'), {
      sessionId: null,
      signal: new AbortController().signal,
    }),
    /WAV/,
  );
  assert.equal(connected, false);
});
