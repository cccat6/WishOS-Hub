import { WebSocket, type ClientOptions } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { randomUUID } from 'node:crypto';
import { MAX_RECORDING_BYTES, type NativeSpeech } from '../voice.js';
import { SpeechUnavailable } from '../speech.js';
export interface CodexSpeechOptions {
  appVersion: string;
  language?: string;
  acceptLanguage?: string;
  proxyUrl?: string;
}
export interface AccountSpeechAuth {
  token: string;
  accountId: string;
  backendOrigin: string;
  routingOverride: string;
  fedramp?: boolean;
}
export type DictationConnector = (
  url: string,
  protocols: string[],
  options: ClientOptions,
) => WebSocket;
export function pcm16Mono(wav: Buffer): Buffer {
  if (
    wav.length < 44 ||
    wav.length > MAX_RECORDING_BYTES + 200 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw Error('Invalid WAV recording');
  let format = false,
    pcm: Buffer | undefined;
  for (let at = 12; at + 8 <= wav.length; ) {
    const n = wav.readUInt32LE(at + 4),
      next = at + 8 + n;
    if (next > wav.length) throw Error('Truncated WAV');
    const tag = wav.toString('ascii', at, at + 4);
    if (tag === 'fmt ') {
      if (
        n < 16 ||
        wav.readUInt16LE(at + 8) !== 1 ||
        wav.readUInt16LE(at + 10) !== 1 ||
        wav.readUInt32LE(at + 12) !== 16000 ||
        wav.readUInt16LE(at + 22) !== 16
      )
        throw Error('Expected mono PCM16 at 16000 Hz');
      format = true;
    }
    if (tag === 'data') {
      if (pcm) throw Error('Duplicate WAV data');
      pcm = wav.subarray(at + 8, next);
    }
    at = next + (n % 2);
  }
  if (!format || !pcm?.length || pcm.length % 2 || pcm.length > MAX_RECORDING_BYTES)
    throw Error('Invalid or empty PCM');
  return pcm;
}
export function dictationSegments(pcm: Buffer): Buffer[] {
  // Keep each upload below the native client's 30-second utterance limit.
  const maximum = 25 * 32000,
    search = 3 * 32000,
    window = 320 * 2;
  const segments: Buffer[] = [];
  for (let at = 0; at < pcm.length; ) {
    let end = Math.min(at + maximum, pcm.length);
    if (end < pcm.length) {
      let best = Infinity;
      const nominal = end;
      for (let cursor = nominal - search; cursor + window <= nominal; cursor += window) {
        let energy = 0;
        for (let sample = cursor; sample < cursor + window; sample += 2) {
          const v = pcm.readInt16LE(sample);
          energy += v * v;
        }
        if (energy <= best) {
          best = energy;
          end = cursor + window;
        }
      }
    }
    segments.push(pcm.subarray(at, end));
    at = end;
  }
  return segments;
}
export class CodexDictation implements NativeSpeech {
  readonly inputSampleRate = 16000;
  readonly available = true;
  constructor(
    private auth: () => Promise<AccountSpeechAuth>,
    private options: CodexSpeechOptions,
    private connect: DictationConnector = (url, p, opts) => new WebSocket(url, p, opts),
  ) {}
  async transcribe(
    wav: Buffer,
    { signal }: { sessionId: string | null; signal: AbortSignal },
  ): Promise<string> {
    const pcm = pcm16Mono(wav);
    const segments = dictationSegments(pcm),
      parts: string[] = [];
    for (const segment of segments) {
      signal.throwIfAborted();
      if (segments.length > 1 && segment.every((value) => value === 0)) continue;
      try {
        parts.push(await this.transcribeSegment(segment, signal));
      } catch (error) {
        if (
          segments.length > 1 &&
          error instanceof Error &&
          error.message === 'No valid speech recognized'
        )
          continue;
        throw error;
      }
    }
    const text = parts.join(' ').trim();
    if (!text || text.length > 16000) throw Error('No valid speech recognized');
    return text;
  }
  private async transcribeSegment(pcm: Buffer, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const auth = await this.auth();
    signal.throwIfAborted();
    const base = new URL(auth.backendOrigin);
    if (
      base.protocol !== 'https:' ||
      !['chatgpt.com', 'us.chatgpt.com', 'eu.chatgpt.com', 'gov.chatgpt.com'].includes(
        base.hostname,
      ) ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      throw new SpeechUnavailable('Unsupported account speech routing');
    const url = new URL('/backend-api/dictation/stream?dictation_surface=composer', base);
    url.protocol = 'wss:';
    const platform =
      process.platform === 'darwin'
        ? 'Mac OS'
        : process.platform === 'win32'
          ? 'Windows NT 10.0'
          : 'X11; Linux';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.token}`,
      'ChatGPT-Account-Id': auth.accountId,
      originator: 'Codex Desktop',
      'User-Agent': `Codex Desktop/${this.options.appVersion} (${platform}; ${process.arch})`,
      'Accept-Language': this.options.acceptLanguage ?? 'zh-Hans-US',
    };
    if (auth.routingOverride !== 'NO_CONSTRAINT')
      headers['X-OpenAI-Account-Routing-Override'] = auth.routingOverride;
    if (auth.fedramp) headers['X-OpenAI-Fedramp'] = 'true';
    const proxy = this.options.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;
    return new Promise((resolve, reject) => {
      const socket = this.connect(url.toString(), ['chatgpt-dictation', 'codex-desktop'], {
        headers,
        agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
        followRedirects: false,
        handshakeTimeout: 15000,
        maxPayload: 1024 * 1024,
      });
      let settled = false,
        started = false,
        sentAudio = false;
      const transcripts = new Map<string, { revision: number; text: string }>();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        socket.terminate();
        if (error) {
          reject(error);
          return;
        }
        const text = [...transcripts.values()]
          .map((v) => v.text.trim())
          .filter(Boolean)
          .join(' ');
        if (!text || text.length > 16000) reject(Error('No valid speech recognized'));
        else resolve(text);
      };
      const abort = () => finish(new Error('Transcription cancelled'));
      const timer = setTimeout(() => finish(Error('Online dictation timed out')), 90000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      const send = (message: unknown) =>
        new Promise<void>((res, rej) => {
          if (settled || socket.readyState !== WebSocket.OPEN) {
            rej(Error('Dictation connection closed'));
            return;
          }
          socket.send(JSON.stringify(message), (error) =>
            error ? rej(Error('Dictation send failed')) : res(),
          );
        });
      socket.on('open', () => {
        void send({
          type: 'session.start',
          dictation_session_id: randomUUID(),
          attempt_id: randomUUID(),
          config: {
            language: this.options.language ?? 'zh',
            input_audio_format: 'pcm16',
            sample_rate_hz: 16000,
            num_channels: 1,
            max_buffer_size_bytes: 4194304,
            max_utterance_duration_ms: 30000,
            session_ttl_ms: 300000,
            provider_mode: 'streaming_sse',
            transcript_delivery_mode: 'final_only',
            vad: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        }).catch(() => finish(Error('Unable to start dictation')));
      });
      socket.on('message', (raw, binary) => {
        if (settled) return;
        try {
          if (binary) throw Error('Unexpected dictation response');
          const message = JSON.parse(raw.toString());
          if (message.type === 'session.started' && !started) {
            started = true;
            void (async () => {
              for (let at = 0; at < pcm.length; at += 6400) {
                sentAudio = true;
                await send({
                  type: 'audio.append',
                  audio: pcm.subarray(at, at + 6400).toString('base64'),
                });
              }
              await send({ type: 'session.close' });
            })().catch(() => finish(Error('Audio transfer incomplete')));
          }
          if (message.type === 'transcript.final') {
            if (
              typeof message.utterance_id !== 'string' ||
              typeof message.text !== 'string' ||
              !Number.isInteger(message.revision) ||
              message.text.length > 16000
            )
              throw Error('Invalid dictation transcript');
            const previous = transcripts.get(message.utterance_id);
            if (!previous || previous.revision < message.revision)
              transcripts.set(message.utterance_id, {
                revision: message.revision,
                text: message.text,
              });
            if (transcripts.size > 128) throw Error('Too many transcript segments');
          }
          if (message.type === 'session.updated' && message.session?.status === 'closed') {
            if (!started) throw Error('Dictation never started');
            finish();
          }
          if (
            message.type === 'transcript.failed' ||
            (message.type === 'session.error' && message.fatal)
          )
            finish(Error('Online speech recognition failed'));
        } catch (error) {
          finish(error instanceof Error ? error : Error('Invalid dictation response'));
        }
      });
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        finish(
          new SpeechUnavailable(`Account dictation unavailable (HTTP ${response.statusCode ?? 0})`),
        );
      });
      socket.on('error', () =>
        finish(
          sentAudio
            ? Error('Dictation disconnected during audio transfer')
            : new SpeechUnavailable('Account dictation connection failed'),
        ),
      );
      socket.on('close', () => {
        if (!settled) finish(Error('Dictation closed before final transcript'));
      });
    });
  }
}
