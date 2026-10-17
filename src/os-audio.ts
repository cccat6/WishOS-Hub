import { decodeVoicePacket, validateVoicePacket } from './voice-codec.js';
export type OsAudioChunk = {
  sequence: number;
  samples: number;
  sample_start: string;
  adpcm_b64: string;
};
/** Preserve compressed packets until an ASR/WAV boundary; sequence gaps are observable. */
export function osAudioPacket(chunk: OsAudioChunk): Buffer {
  if (
    !Number.isInteger(chunk.sequence) ||
    chunk.sequence < 0 ||
    !Number.isInteger(chunk.samples) ||
    chunk.samples < 1 ||
    chunk.samples > 1280 ||
    typeof chunk.sample_start !== 'string' ||
    !/^\d+$/.test(chunk.sample_start)
  )
    throw Error('invalid_audio_chunk');
  const packet = Buffer.from(chunk.adpcm_b64, 'base64');
  if (
    packet.toString('base64') !== chunk.adpcm_b64 ||
    packet.length !== 11 + Math.ceil(chunk.samples / 2) ||
    packet[0] !== 0x42 ||
    packet.readUInt32LE(1) !== chunk.sequence ||
    packet.readUInt16LE(9) !== chunk.samples
  )
    throw Error('invalid_audio_packet');
  validateVoicePacket(packet);
  return packet;
}
export function decodeOsAudioChunk(chunk: OsAudioChunk): Buffer {
  return decodeVoicePacket(osAudioPacket(chunk));
}
/** WAB1 contains the original independently decodable packets, not one long codec stream. */
export function unpackOsAudioBatch(encoded: string, maximumChunks: number): OsAudioChunk[] {
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.toString('base64') !== encoded ||
    bytes.length < 6 ||
    bytes.toString('latin1', 0, 4) !== 'WAB1'
  )
    throw Error('invalid_audio_batch');
  const count = bytes.readUInt16LE(4);
  if (count > maximumChunks || count > Math.floor((bytes.length - 6) / 22))
    throw Error('invalid_audio_batch_count');
  const chunks: OsAudioChunk[] = [];
  let offset = 6;
  for (let n = 0; n < count; n++) {
    if (offset + 10 > bytes.length) throw Error('invalid_audio_batch_record');
    const start = bytes.readBigUInt64LE(offset),
      size = bytes.readUInt16LE(offset + 8);
    offset += 10;
    if (size < 12 || offset + size > bytes.length) throw Error('invalid_audio_batch_packet');
    const packet = bytes.subarray(offset, offset + size);
    const chunk = {
      sequence: packet.readUInt32LE(1),
      samples: packet.readUInt16LE(9),
      sample_start: start.toString(),
      adpcm_b64: packet.toString('base64'),
    };
    osAudioPacket(chunk);
    const prior = chunks.at(-1);
    if (
      prior &&
      (chunk.sequence <= prior.sequence ||
        start < BigInt(prior.sample_start) + BigInt(prior.samples))
    )
      throw Error('invalid_audio_batch_order');
    chunks.push(chunk);
    offset += size;
  }
  if (offset !== bytes.length) throw Error('invalid_audio_batch_trailing');
  return chunks;
}
