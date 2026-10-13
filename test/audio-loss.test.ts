import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioStream } from '../src/voice.js';
function frame(seq: number) {
  const b = Buffer.alloc(645);
  b[0] = 0x41;
  b.writeUInt32LE(seq, 1);
  for (let at = 5; at < b.length; at += 2) b.writeInt16LE(1000, at);
  return b;
}
function stream() {
  return new AudioStream('test', null, undefined, 320);
}
test('mild internal and trailing gaps become silence with the original timeline preserved', () => {
  const s = stream();
  for (let n = 0; n < 200; n++) if (n !== 70 && n !== 199) s.append(frame(n));
  const wav = s.finish(200, true);
  assert.equal(s.missingSamples, 640);
  assert.equal(s.receivedBytes, 198 * 640);
  assert.equal(wav.length, 44 + 200 * 640);
  assert.equal(wav.readInt16LE(44 + 70 * 640), 0);
  assert.equal(wav.readInt16LE(44 + 71 * 640), 1000);
  assert.equal(wav.readInt16LE(44 + 199 * 640), 0);
});
test('loss exactly 5 percent and 200ms is tolerated, worse ratio/burst/cumulative loss fails', () => {
  const okay = stream();
  for (let n = 0; n < 200; n++) if (n < 50 || n >= 60) okay.append(frame(n));
  assert.ok(okay.finish(200, true));
  const ratio = stream();
  for (let n = 0; n < 100; n++) if (n % 10 !== 0) ratio.append(frame(n));
  assert.throws(() => ratio.finish(100, true), /5 percent/);
  assert.throws(() => stream().append(frame(11)), /200 ms/);
  const total = stream();
  let n = 0;
  for (let i = 0; i < 5; i++) {
    total.append(frame(n));
    n += 11;
    total.append(frame(n++));
  }
  total.append(frame(n++));
  assert.throws(() => total.append(frame(n + 1)), /cumulative/);
});
test('explicit cancellation, duplicates, unnegotiated gaps and entirely absent clips are never submitted', () => {
  const s = stream();
  s.append(frame(0));
  assert.throws(() => s.finish(1, false), /incomplete/);
  assert.throws(() => s.append(frame(0)), /duplicate/);
  assert.throws(() => stream().finish(10, true), /incomplete/);
  assert.throws(() => new AudioStream('legacy').append(frame(1)), /sequence gap/);
  assert.throws(() => stream().append(Buffer.alloc(1285, 0x41)), /frame size/);
});
