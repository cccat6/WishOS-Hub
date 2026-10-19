import { TtsConfig, TtsService } from '../tts.js';
import type { LocalSecrets } from './secrets.js';
export function resolveTts(config: TtsConfig, secrets: LocalSecrets) {
  const c = config.online,
    key = c?.tokenRef ? secrets.get(c.tokenRef) : c?.tokenEnv ? process.env[c.tokenEnv] : '';
  const configured = !((c?.tokenRef || c?.tokenEnv) && !key);
  return {
    service: new TtsService(config, key ?? '', fetch, configured),
    credentialConfigured: configured,
  };
}
