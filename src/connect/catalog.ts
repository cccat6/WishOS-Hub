import type { RuntimeConfig } from './config.js';
export const runtimeCatalog = [
  {
    kind: 'codex',
    label: 'Codex',
    command: 'codex',
    ingress: 'app-server',
    continuation: 'native-thread',
    source: 'https://learn.chatgpt.com/docs/app-server',
  },
  {
    kind: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    ingress: 'cli-owned-session',
    continuation: 'native-session',
    source: 'https://code.claude.com/docs/en/channels-reference',
  },
  {
    kind: 'deepseek',
    label: 'DeepSeek Harness',
    command: 'dsh',
    ingress: 'acp',
    continuation: 'native-session',
    source: 'https://github.com/deepseek-ai/deepseek-harness',
  },
  {
    kind: 'cursor',
    label: 'Cursor',
    command: 'agent',
    ingress: 'acp',
    continuation: 'cli-session',
    source: 'https://cursor.com/docs/cli/using',
  },
  {
    kind: 'workbuddy',
    label: 'WorkBuddy',
    ingress: 'authorized-open-api-acp',
    continuation: 'vendor-task',
    source: 'https://open.workbuddy.cn/docs/openapi',
  },
  {
    kind: 'openclaw',
    label: 'OpenClaw',
    ingress: 'gateway',
    continuation: 'gateway-session',
    source: 'https://docs.openclaw.ai/gateway/openresponses-http-api',
  },
  {
    kind: 'hermes',
    label: 'Hermes Agent',
    ingress: 'api-server',
    continuation: 'owned-api-session',
    source: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server',
  },
  {
    kind: 'chatgpt',
    label: 'ChatGPT',
    ingress: 'remote-mcp-tools',
    continuation: 'chatgpt-owned',
    source: 'https://learn.chatgpt.com/docs/extend/mcp',
  },
] as const;
export function runtimeDescription(r: RuntimeConfig) {
  const spec = runtimeCatalog.find((x) => x.kind === r.kind)!;
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    ingress: spec.ingress,
    session_owner: 'selected_runtime',
    credential_owner: 'user_host',
    validation: 'documented_interface',
    authorization_configured:
      r.kind === 'workbuddy'
        ? Boolean(r.authTokenEnv && process.env[r.authTokenEnv])
        : !r.authTokenEnv || Boolean(process.env[r.authTokenEnv]),
    source: spec.source,
  };
}
