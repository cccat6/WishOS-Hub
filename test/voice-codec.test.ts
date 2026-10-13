import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeVoicePacket } from '../src/voice-codec.js';
import { AudioStream } from '../src/voice.js';
const wire = readFileSync(new URL('./fixtures/voice-codec-fixture.bin', import.meta.url)),
  pcm = readFileSync(new URL('./fixtures/voice-codec-reference.pcm', import.meta.url)),
  independent = readFileSync(new URL('./fixtures/voice-codec-ffmpeg.pcm', import.meta.url));
test('real firmware encoder matches independent FFmpeg IMA decoder and preserves voice-band signal', () => {
  let square = 0,
    signal = 0;
  for (let n = 0; n < 10; n++) {
    const decoded = decodeVoicePacket(wire.subarray(n * 651, (n + 1) * 651));
    assert.deepEqual(decoded, independent.subarray(n * 2562 + 2, (n + 1) * 2562));
    for (let i = 0; i < 1280; i++)
      if (n || i > 160) {
        const src = pcm.readInt16LE((n * 1280 + i) * 2),
          out = decoded.readInt16LE(i * 2);
        square += (src - out) ** 2;
        signal += src ** 2;
      }
  }
  assert.ok(Math.sqrt(square / signal) < 0.1);
});
test('compressed frames are independent after a dropped frame; partial final frame keeps exact duration', () => {
  const stream = new AudioStream('codec', null, undefined, 1280, 'ima-adpcm');
  // 80 ms gap below 5% requires enough received audio; repeat independent fixtures with new sequences.
  for (let n = 0; n < 50; n++)
    if (n !== 22) {
      const b = Buffer.from(wire.subarray((n % 10) * 651, ((n % 10) + 1) * 651));
      b.writeUInt32LE(n, 1);
      stream.append(b);
    }
  const last = Buffer.from(wire.subarray(0, 651));
  last.writeUInt32LE(50, 1);
  last.writeUInt16LE(320, 9);
  stream.append(last.subarray(0, 171));
  const wav = stream.finish(51, true, 50 * 1280 + 320);
  assert.equal(wav.length, 44 + (50 * 1280 + 320) * 2);
  assert.equal(stream.missingSamples, 1280);
  assert.throws(() => decodeVoicePacket(Buffer.alloc(651)), /invalid/);
  const bad = Buffer.from(wire.subarray(0, 651));
  bad[7] = 89;
  assert.throws(() => decodeVoicePacket(bad), /invalid/);
});
