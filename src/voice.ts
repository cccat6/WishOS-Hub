import { decodeVoicePacket } from './voice-codec.js';
export interface Asr {
  transcribe(wav: Buffer, signal?: AbortSignal): Promise<string>;
}
export const MAX_RECORDING_SECONDS = 300;
export const MAX_RECORDING_BYTES = 16000 * 2 * MAX_RECORDING_SECONDS;
export const AUDIO_UPLOAD_TIMEOUT_MS = MAX_RECORDING_SECONDS * 1000 + 35000;
export interface NativeSpeech {
  readonly inputSampleRate?: number;
  readonly available: boolean;
  readonly reason?: string;
  transcribe(
    wav: Buffer,
    context: { sessionId: string | null; signal: AbortSignal },
  ): Promise<string>;
}
export class HttpAsr implements Asr {
  constructor(
    private url: string,
    private token?: string,
    private options: {
      protocol?: 'wav-json' | 'openai-compatible';
      model?: string;
      language?: string;
      timeoutMs?: number;
    } = {},
  ) {}
  async transcribe(wav: Buffer, signal?: AbortSignal) {
    let body: BodyInit = new Uint8Array(wav);
    const headers: Record<string, string> = {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
    if (this.options.protocol === 'openai-compatible') {
      if (!this.options.model?.trim()) throw Error('ASR model name required');
      const form = new FormData();
      form.append('file', new Blob([Uint8Array.from(wav)], { type: 'audio/wav' }), 'recording.wav');
      form.append('model', this.options.model);
      form.append('response_format', 'json');
      if (this.options.language) form.append('language', this.options.language);
      body = form;
    } else headers['Content-Type'] = 'audio/wav';
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60000);
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`ASR HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty ASR response');
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 64000) {
        await reader.cancel();
        throw new Error('ASR response too large');
      }
      parts.push(part.value);
    }
    const raw = Buffer.concat(parts).toString('utf8');
    const data = JSON.parse(raw);
    if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 16000)
      throw new Error('ASR returned invalid text');
    return data.text;
  }
}
export class AudioStream {
  chunks: Buffer[] = [];
  bytes = 0;
  next = 0;
  started = Date.now();
  receivedBytes = 0;
  receivedChunks = 0;
  missingSamples = 0;
  maxGapSamples = 0;
  constructor(
    public id: string,
    public sessionId?: string | null,
    public recognizer?: Asr,
    public frameSamples = 0,
    public encoding = 'pcm-s16le',
  ) {}
  private fillGap(count: number, tailSamples?: number) {
    if (!count) return;
    if (!this.frameSamples) throw Error('audio sequence gap');
    const samples = tailSamples ?? count * this.frameSamples;
    if (
      samples < 1 ||
      samples > count * this.frameSamples ||
      samples <= (count - 1) * this.frameSamples
    )
      throw Error('invalid trailing sample count');
    if (samples > 3200 || this.missingSamples + samples > 16000)
      throw Error('audio loss too severe: burst >200 ms or cumulative >1 s');
    if (this.bytes + samples * 2 > MAX_RECORDING_BYTES) throw Error('audio duration limit');
    this.chunks.push(Buffer.alloc(samples * 2));
    this.bytes += samples * 2;
    this.missingSamples += samples;
    this.maxGapSamples = Math.max(this.maxGapSamples, samples);
    this.next += count;
  }
  append(frame: Buffer) {
    // Both wire formats use uint32le sequence numbers; decode before ASR.
    let pcm: Buffer;
    if (this.encoding === 'ima-adpcm') pcm = decodeVoicePacket(frame);
    else {
      if (frame.length < 7 || frame.length > 1285 || frame[0] !== 0x41 || (frame.length - 5) % 2)
        throw Error('invalid audio frame');
      pcm = frame.subarray(5);
    }
    const sequence = frame.readUInt32LE(1);
    if (sequence < this.next) throw Error('duplicate or reordered audio frame');
    if (this.frameSamples && this.encoding !== 'ima-adpcm' && pcm.length !== this.frameSamples * 2)
      throw Error('invalid audio frame size');
    this.fillGap(sequence - this.next);
    if (
      this.bytes + pcm.length > MAX_RECORDING_BYTES ||
      Date.now() - this.started > AUDIO_UPLOAD_TIMEOUT_MS
    )
      throw new Error('audio duration limit');
    this.next++;
    this.bytes += pcm.length;
    this.receivedBytes += pcm.length;
    this.receivedChunks++;
    this.chunks.push(Buffer.from(pcm));
  }
  finish(chunks: number, complete: boolean, totalSamples?: number) {
    if (!complete || chunks < this.next || !this.receivedBytes)
      throw new Error('incomplete recording; not submitted to agent');
    this.fillGap(
      chunks - this.next,
      totalSamples === undefined ? undefined : totalSamples - this.bytes / 2,
    );
    if (totalSamples !== undefined && totalSamples !== this.bytes / 2)
      throw Error('audio sample count mismatch');
    if (this.missingSamples * 20 > this.bytes / 2)
      throw Error('audio loss too severe: missing >5 percent');
    const pcm = Buffer.concat(this.chunks),
      header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }
}
