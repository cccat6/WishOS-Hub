import test from 'node:test';
import assert from 'node:assert/strict';
import { unpackOsAudioBatch, decodeOsAudioChunk } from '../src/os-audio.js';
import { readFile } from 'node:fs/promises';

import { packBatch } from './fixtures/audio-batch.js';
function packet(sequence: number, samples = 160) {
  const p = Buffer.alloc(11 + Math.ceil(samples / 2));
  p[0] = 0x42;
  p.writeUInt32LE(sequence, 1);
  p.writeUInt16LE(samples, 9);
  return p;
}

test('WAB1 preserves independent compressed packets, gaps, a partial tail and uint64 sample positions', async () => {
  const native = await readFile(new URL('./fixtures/os-voice-ima.bin', import.meta.url));
  const chunks = [
    { sample_start: '0', adpcm_b64: native.subarray(0, 91).toString('base64') },
    { sample_start: '320', adpcm_b64: native.subarray(182, 273).toString('base64') },
    { sample_start: '9007199254740993', adpcm_b64: packet(99, 5).toString('base64') },
  ];
  const result = unpackOsAudioBatch(packBatch(chunks), 24);
  assert.deepEqual(
    result.map((c) => c.sequence),
    [0, 2, 99],
  );
  assert.deepEqual(
    result.map((c) => c.sample_start),
    chunks.map((c) => c.sample_start),
  );
  assert.deepEqual(
    result.map((c) => c.adpcm_b64),
    chunks.map((c) => c.adpcm_b64),
  );
  assert.equal(decodeOsAudioChunk(result[2]).length, 10);
  assert.equal(decodeOsAudioChunk(result[1]).length, 320);
  assert.deepEqual(unpackOsAudioBatch(packBatch([]), 24), []);
});

test('WAB1 rejects malformed or overlapping batches atomically rather than returning a usable prefix', () => {
  const source = Buffer.from(
    packBatch([
      { sample_start: '0', adpcm_b64: packet(0).toString('base64') },
      { sample_start: '160', adpcm_b64: packet(1).toString('base64') },
    ]),
    'base64',
  );
  const bad: Buffer[] = [
    source.subarray(0, 5),
    source.subarray(0, source.length - 1),
    Buffer.concat([source, Buffer.from([0])]),
  ];
  for (const change of [
    (b: Buffer) => b.write('BAD1'),
    (b: Buffer) => b.writeUInt16LE(99, 4),
    (b: Buffer) => b.writeUInt16LE(65535, 14),
    (b: Buffer) => b.writeUInt16LE(11, 14),
    (b: Buffer) => b.writeUInt16LE(0, 25),
    (b: Buffer) => b.writeUInt8(89, 23),
    (b: Buffer) => b.writeUInt8(1, 24),
    (b: Buffer) => b.writeUInt32LE(0, 118),
    (b: Buffer) => b.writeBigUInt64LE(159n, 107),
  ]) {
    const b = Buffer.from(source);
    change(b);
    bad.push(b);
  }
  for (const b of bad) assert.throws(() => unpackOsAudioBatch(b.toString('base64'), 24));
  assert.throws(() => unpackOsAudioBatch(source.toString('base64'), 1), /count/);
  assert.throws(
    () => unpackOsAudioBatch(source.toString('base64') + ' ', 24),
    /invalid_audio_batch/,
  );
});

test('a full compact batch fits the unchanged control envelope while retaining each original packet', () => {
  const chunks = Array.from({ length: 24 }, (_, i) => ({
    sample_start: String(i * 160),
    adpcm_b64: packet(i).toString('base64'),
  }));
  const batch = packBatch(chunks);
  assert.equal(unpackOsAudioBatch(batch, 32).length, 24);
  const wire = {
    id: 1,
    boot_id: 'b',
    ok: true,
    result: {
      recording_id: 'b-1',
      sample_rate: 16000,
      recording: true,
      encoding: 'ima-adpcm',
      batch_encoding: 'wishos-audio-batch/1',
      batch_b64: batch,
      offered_sequence: 24,
    },
  };
  assert(Buffer.byteLength(JSON.stringify(wire)) < 4096);
  const b = Buffer.from(batch, 'base64');
  b[0] |= 128;
  assert.throws(() => unpackOsAudioBatch(b.toString('base64'), 32), /invalid_audio_batch/);
});

test('compressed batch admission validates state without allocating throwaway PCM; decoding stays at its consumer boundary', async (t) => {
  const { osAudioPacket } = await import('../src/os-audio.js');
  const { OsAudioIngress } = await import('../src/os-audio-ingress.js');
  const { DatabaseSync } = await import('node:sqlite');
  const chunks = Array.from({ length: 24 }, (_, i) => ({
    sequence: i,
    samples: 160,
    sample_start: String(i * 160),
    adpcm_b64: packet(i).toString('base64'),
  }));
  const encoded = packBatch(chunks),
    db = new DatabaseSync(':memory:');
  const ingress = new OsAudioIngress(db, async () => ({}));
  ingress.begin('d', 'r', { sample_rate: 16000 });
  const allocate = Buffer.alloc;
  let pcmAllocations = 0;
  const spy = t.mock.method(Buffer, 'alloc', (...args: Parameters<typeof Buffer.alloc>) => {
    if (args[0] === chunks[0].samples * 2) pcmAllocations++;
    return allocate(...args);
  });
  try {
    const decodedContainer = unpackOsAudioBatch(encoded, 30);
    const stored = ingress.append('d', 'r', decodedContainer);
    assert.equal(stored.blocks, 24);
    assert.equal(stored.durable, true);
    assert.equal(pcmAllocations, 0);
    assert.equal(decodeOsAudioChunk(decodedContainer[0]).length, chunks[0].samples * 2);
    assert.equal(pcmAllocations, 1);
    const malformed = Buffer.from(chunks[0].adpcm_b64, 'base64');
    malformed[7] = 89;
    const invalid = { ...chunks[0], adpcm_b64: malformed.toString('base64') };
    assert.throws(() => osAudioPacket(invalid), /ADPCM/);
    assert.throws(() => ingress.append('d', 'r', [invalid]), /invalid_audio_packet/);
    assert.equal(ingress.status('d', 'r').blocks, 24);
  } finally {
    spy.mock.restore();
    await ingress.close();
    db.close();
  }
});
