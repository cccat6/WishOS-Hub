import { speechWavRate } from './voice-resample.js';
import { z } from 'zod';
import { HttpAsr, type Asr, type NativeSpeech } from './voice.js';
const endpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash;
    } catch {
      return false;
    }
  }, 'Invalid transcription endpoint');
export const ThirdPartySpeechConfig = z
  .object({
    protocol: z.enum(['wav-json', 'openai-compatible']).default('openai-compatible'),
    url: endpoint,
    token: z
      .string()
      .max(8192)
      .refine((value) => !/[\r\n]/.test(value))
      .default(''),
    model: z.string().max(128).default(''),
    language: z.string().max(32).default(''),
    timeoutMs: z.number().int().min(1000).max(120000).default(60000),
  })
  .strict()
  .refine(
    (value) => value.protocol !== 'openai-compatible' || !!value.model.trim(),
    'Model name required',
  );
export const SpeechConfig = z
  .object({
    source: z.enum(['harness', 'third-party']).default('harness'),
    fallbackToThirdParty: z.boolean().default(true),
    thirdParty: ThirdPartySpeechConfig.nullable().default(null),
  })
  .strict();
export type SpeechConfig = z.infer<typeof SpeechConfig>;
export class SpeechUnavailable extends Error {}
export interface SpeechHarness {
  name: string;
  nativeSpeech?: NativeSpeech;
}
export class SpeechSettings {
  private config: SpeechConfig;
  constructor(
    initial?: unknown,
    private fallbackAsr?: Asr,
  ) {
    this.config = SpeechConfig.parse(initial ?? {});
  }
  get() {
    return structuredClone(this.config);
  }
  private thirdParty(config: SpeechConfig): Asr | undefined {
    return config.thirdParty
      ? new HttpAsr(config.thirdParty.url, config.thirdParty.token, config.thirdParty)
      : this.fallbackAsr;
  }
  describe(harness: SpeechHarness) {
    const native = harness.nativeSpeech;
    const third = !!this.config.thirdParty || !!this.fallbackAsr;
    const effective =
      this.config.source === 'third-party'
        ? third
          ? 'third-party'
          : null
        : native?.available
          ? 'harness'
          : this.config.fallbackToThirdParty && third
            ? 'third-party'
            : null;
    return {
      requested_source: this.config.source,
      effective_source: effective,
      available: effective !== null,
      harness_available: !!native?.available,
      harness_reason: native?.available
        ? null
        : (native?.reason ?? '当前 Harness 适配器尚未提供原生语音识别'),
      third_party_configured: third,
      fallback_active: this.config.source === 'harness' && effective === 'third-party',
    };
  }
  capture(harness: SpeechHarness, sessionId: string | null, signal: AbortSignal): Asr | undefined {
    const config = this.get(),
      native = harness.nativeSpeech,
      third = this.thirdParty(config);
    if (config.source === 'third-party')
      return third ? { transcribe: (wav) => third.transcribe(wav, signal) } : undefined;
    if (!native?.available)
      return config.fallbackToThirdParty && third
        ? { transcribe: (wav) => third.transcribe(wav, signal) }
        : undefined;
    // Selection and credentials are captured once, before recording. Only an explicit
    // native-capability-unavailable error permits the user's configured fallback.
    return {
      transcribe: async (wav) => {
        try {
          const input = native.inputSampleRate
            ? await speechWavRate(wav, native.inputSampleRate, signal)
            : wav;
          return await native.transcribe(input, { sessionId, signal });
        } catch (error) {
          if (error instanceof SpeechUnavailable && config.fallbackToThirdParty && third)
            return third.transcribe(wav, signal);
          throw error;
        }
      },
    };
  }
}
