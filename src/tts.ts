import { z } from 'zod';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pcmWav } from './voice.js';
import { speechWavRate } from './voice-resample.js';
import { encodeVoicePacket } from './voice-codec.js';
const endpoint = z
  .string()
  .url()
  .refine((s) => {
    const u = new URL(s);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash;
  });
export const TtsConfig = z
  .object({
    source: z.enum(['disabled', 'macos-say', 'openai-compatible']).default('disabled'),
    voice: z.string().min(1).max(128).default('Tingting'),
    online: z
      .object({
        url: endpoint,
        model: z.string().min(1).max(128),
        voice: z.string().min(1).max(128),
        tokenEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .optional(),
        tokenRef: z
          .string()
          .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
          .optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(1000).max(120000).default(60000),
    maxTextBytes: z.number().int().min(1).max(100000).default(12000),
    maxAudioBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(16 * 1024 * 1024),
  })
  .strict()
  .refine(
    (c) => c.source !== 'openai-compatible' || Boolean(c.online),
    'TTS online service required',
  );
export type TtsConfig = z.infer<typeof TtsConfig>;
export const ReplyPreference = z
  .object({
    mode: z.enum(['text', 'speech']).default('text'),
    voice: z.string().min(1).max(128).optional(),
  })
  .passthrough();
export type ReplyPreference = z.infer<typeof ReplyPreference>;
/** RIFF chunks may include metadata/padding; accept actual PCM16, not assumed offsets. */
export function ttsPcm(wav: Buffer) {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) + 8 !== wav.length
  )
    throw Error('tts_wav_format');
  let rate = 0,
    channels = 0,
    data: Buffer | undefined;
  for (let at = 12; at + 8 <= wav.length; ) {
    const size = wav.readUInt32LE(at + 4),
      begin = at + 8,
      end = begin + size;
    if (end > wav.length) throw Error('tts_wav_format');
    const tag = wav.toString('ascii', at, at + 4);
    if (tag === 'fmt ') {
      if (size < 16 || wav.readUInt16LE(begin) !== 1 || wav.readUInt16LE(begin + 14) !== 16)
        throw Error('tts_wav_format');
      channels = wav.readUInt16LE(begin + 2);
      rate = wav.readUInt32LE(begin + 4);
    }
    if (tag === 'data') {
      if (data) throw Error('tts_wav_format');
      data = wav.subarray(begin, end);
    }
    at = end + (size & 1);
  }
  if (
    !data ||
    !data.length ||
    ![1, 2].includes(channels) ||
    rate < 8000 ||
    rate > 192000 ||
    data.length % (channels * 2)
  )
    throw Error('tts_wav_format');
  const pcm = Buffer.alloc(data.length / channels);
  for (let at = 0; at < pcm.length; at += 2) {
    let sample = data.readInt16LE(at * channels);
    if (channels === 2) sample = Math.round((sample + data.readInt16LE(at * 2 + 2)) / 2);
    pcm.writeInt16LE(sample, at);
  }
  return { pcm, rate };
}
export type SynthesizedSpeech = {
  bytes: Buffer;
  samples: number;
  sample_rate_hz: 16000;
  packet_bytes: 331;
};
export class TtsService {
  readonly config: TtsConfig;
  constructor(
    config: unknown = {},
    private token = '',
    private fetcher: typeof fetch = fetch,
    private credentialsAvailable = true,
  ) {
    this.config = TtsConfig.parse(config);
  }
  describe() {
    return {
      source: this.config.source,
      available:
        this.credentialsAvailable &&
        (this.config.source === 'macos-say'
          ? process.platform === 'darwin'
          : this.config.source === 'openai-compatible'),
      encoding: 'ima-adpcm-block',
      sample_rate_hz: 16000,
      channels: 1,
      credentials_owner: 'user-host',
    };
  }
  async synthesize(
    text: string,
    voice: string | undefined,
    signal: AbortSignal,
  ): Promise<SynthesizedSpeech> {
    if (!this.credentialsAvailable) throw Error('tts_credentials_unavailable');
    if (!text.trim() || Buffer.byteLength(text) > this.config.maxTextBytes)
      throw Error('tts_text_limit');
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
    bounded.throwIfAborted();
    let wav: Buffer;
    if (this.config.source === 'macos-say') {
      if (process.platform !== 'darwin') throw Error('tts_backend_unavailable');
      const dir = await mkdtemp(join(tmpdir(), 'wishos-tts-'));
      try {
        const input = join(dir, 'text.txt'),
          output = join(dir, 'speech.wav');
        await writeFile(input, text, { mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            '/usr/bin/say',
            [
              '-v',
              voice ?? this.config.voice,
              '-f',
              input,
              '-o',
              output,
              '--file-format=WAVE',
              '--data-format=LEI16@16000',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'], signal: bounded, shell: false },
          );
          let failure: Error | undefined;
          child.once('error', () => {
            failure = Error(bounded.aborted ? 'tts_cancelled' : 'tts_backend_failed');
          });
          child.once('close', (code) =>
            failure
              ? reject(failure)
              : code === 0
                ? resolve()
                : reject(Error(bounded.aborted ? 'tts_cancelled' : 'tts_backend_failed')),
          );
        });
        if ((await stat(output)).size > this.config.maxAudioBytes) throw Error('tts_audio_limit');
        wav = await readFile(output);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else if (this.config.source === 'openai-compatible') {
      const c = this.config.online!;
      let response: Response;
      try {
        response = await this.fetcher(c.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
          },
          body: JSON.stringify({
            model: c.model,
            voice: voice ?? c.voice,
            input: text,
            response_format: 'wav',
          }),
          redirect: 'error',
          signal: bounded,
        });
      } catch {
        throw Error(bounded.aborted ? 'tts_cancelled' : 'tts_transport_failed');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Error('tts_HTTP_' + response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error('tts_audio_missing');
      const chunks: Buffer[] = [];
      let count = 0;
      try {
        for (;;) {
          bounded.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          count += part.value.length;
          if (count > this.config.maxAudioBytes) throw Error('tts_audio_limit');
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      wav = Buffer.concat(chunks, count);
    } else throw Error('tts_unavailable');
    bounded.throwIfAborted();
    const input = ttsPcm(wav),
      normal = await speechWavRate(pcmWav(input.pcm, input.rate), 16000, bounded),
      pcm = normal.subarray(44),
      packets: Buffer[] = [],
      state = { predictor: 0, index: 0 };
    for (let at = 0, seq = 0; at < pcm.length; at += 1280, seq++) {
      if (seq % 64 === 0) {
        bounded.throwIfAborted();
        await new Promise<void>((r) => setImmediate(r));
      }
      packets.push(encodeVoicePacket(pcm.subarray(at, at + 1280), seq, state));
    }
    return {
      bytes: Buffer.concat(packets),
      samples: pcm.length / 2,
      sample_rate_hz: 16000,
      packet_bytes: 331,
    };
  }
}
