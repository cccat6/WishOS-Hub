import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { AudioStream, MAX_RECORDING_BYTES, AUDIO_UPLOAD_TIMEOUT_MS } from '../src/voice.js';
import { CodexDictation, dictationSegments, pcm16Mono } from '../src/adapters/codex-dictation.js';

function wave(pcm: Buffer) {
  const h = Buffer.alloc(44);
  h.write('RIFF');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
test('five-minute device audio is complete, bounded and valid mono WAV; 60-second clips no longer time out', () => {
  const stream = new AudioStream('five-minutes');
  stream.started -= 61000;
  const packet = Buffer.alloc(645);
  packet[0] = 0x41;
  for (let seq = 0; seq < MAX_RECORDING_BYTES / 640; seq++) {
    packet.writeUInt32LE(seq, 1);
    stream.append(packet);
  }
  assert.equal(stream.bytes, 9600000);
  const wav = stream.finish(stream.next, true);
  assert.equal(pcm16Mono(wav).length, MAX_RECORDING_BYTES);
  packet.writeUInt32LE(stream.next, 1);
  assert.throws(() => stream.append(packet), /duration/);
  const timedOut = new AudioStream('timeout');
  timedOut.started -= AUDIO_UPLOAD_TIMEOUT_MS + 1;
  packet.writeUInt32LE(0, 1);
  assert.throws(() => timedOut.append(packet), /duration/);
  assert.throws(() => stream.finish(stream.next, false), /incomplete/);
});
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
