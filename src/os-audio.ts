import { decodeVoicePacket } from './voice-codec.js';
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
  decodeVoicePacket(packet);
  return packet;
}
export function decodeOsAudioChunk(chunk: OsAudioChunk): Buffer {
  return decodeVoicePacket(osAudioPacket(chunk));
}
