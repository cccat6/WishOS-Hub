import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { pcmWav } from '../src/voice.js';
import { CodexDictation, dictationSegments, pcm16Mono } from '../src/adapters/codex-dictation.js';

const wave = (pcm: Buffer) => pcmWav(pcm, 16000);
test('native dictation chunks retain every sample and prefer a quiet boundary', () => {
  const pcm = Buffer.alloc(300 * 32000, 1);
  pcm.fill(0, 23 * 32000, 23.2 * 32000);
  const segments = dictationSegments(pcm);
  assert.ok(segments.length >= 12);
  assert.ok(segments.every((s) => s.length <= 25 * 32000 && s.length % 2 === 0));
  assert.equal(segments[0]!.length, 23.2 * 32000);
  assert.deepEqual(Buffer.concat(segments), pcm);
});
test('native five-minute transcription joins all segment results in order before returning to Harness', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  let sessions = 0;
  const received: Buffer[] = [];
  server.on('connection', (ws) => {
    const index = sessions++;
    const audio: Buffer[] = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'session.start') ws.send(JSON.stringify({ type: 'session.started' }));
      if (m.type === 'audio.append') audio.push(Buffer.from(m.audio, 'base64'));
      if (m.type === 'session.close') {
        const joined = Buffer.concat(audio);
        assert.ok(joined.length <= 25 * 32000);
        received.push(joined);
        ws.send(
          JSON.stringify({
            type: 'transcript.final',
            utterance_id: 'a',
            revision: 1,
            text: '段' + index,
          }),
        );
        ws.send(JSON.stringify({ type: 'session.updated', session: { status: 'closed' } }));
      }
    });
  });
  const native = new CodexDictation(
    async () => ({
      token: 'test-token',
      accountId: 'fixture',
      backendOrigin: 'https://chatgpt.com',
      routingOverride: 'NO_CONSTRAINT',
    }),
    { appVersion: 'fixture' },
    () => new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}`),
  );
  try {
    const pcm = Buffer.alloc(300 * 32000, 1);
    const text = await native.transcribe(wave(pcm), {
      sessionId: 'fixed',
      signal: new AbortController().signal,
    });
    assert.equal(text, Array.from({ length: 12 }, (_, i) => '段' + i).join(' '));
    assert.deepEqual(Buffer.concat(received), pcm);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
