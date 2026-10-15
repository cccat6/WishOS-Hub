export interface Asr {
  transcribe(wav: Buffer, signal?: AbortSignal): Promise<string>;
}
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

/** PCM/WAV is created only at the upstream ASR boundary; device transport stays compressed. */
export function pcmWav(pcm: Buffer, sampleRate: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
