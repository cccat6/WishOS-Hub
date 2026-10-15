import { z } from 'zod';
import type { SpeechConfig } from '../speech.js';
import type { LocalSecrets } from './secrets.js';
const endpoint = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash;
  });
export const LocalSpeechConfig = z
  .object({
    source: z.enum(['harness', 'third-party']).default('harness'),
    fallbackToThirdParty: z.boolean().default(true),
    thirdParty: z
      .object({
        protocol: z.enum(['wav-json', 'openai-compatible']).default('openai-compatible'),
        url: endpoint,
        model: z.string().max(128).default(''),
        language: z.string().max(32).default(''),
        timeoutMs: z.number().int().min(1000).max(120000).default(60000),
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
      .refine((c) => c.protocol !== 'openai-compatible' || Boolean(c.model), 'ASR model required')
      .nullable()
      .default(null),
  })
  .strict()
  .refine((c) => c.source !== 'third-party' || Boolean(c.thirdParty), 'ASR service required');
export type LocalSpeechConfig = z.infer<typeof LocalSpeechConfig>;
export function resolveSpeech(
  config: LocalSpeechConfig,
  secrets: LocalSecrets,
): { applied: SpeechConfig; credentialConfigured: boolean } {
  const external = config.thirdParty;
  const key = external?.tokenRef
    ? secrets.get(external.tokenRef)
    : external?.tokenEnv
      ? process.env[external.tokenEnv]
      : '';
  const missing = Boolean((external?.tokenRef || external?.tokenEnv) && !key);
  const { tokenEnv: _, tokenRef: __, ...service } = external ?? {};
  return {
    applied: {
      source: config.source,
      fallbackToThirdParty: config.fallbackToThirdParty,
      thirdParty:
        external && !missing
          ? ({ ...service, token: key ?? '' } as SpeechConfig['thirdParty'])
          : null,
    },
    credentialConfigured: !missing,
  };
}
