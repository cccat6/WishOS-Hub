import { resolve } from 'node:path';
import type { ConnectorConfig } from './config.js';
export function clientConfigurations(config: ConnectorConfig, entry: string, dataRoot: string) {
  const local = {
    command: process.execPath,
    args: [
      ...(Number(process.versions.node.split('.')[0]) >= 24 ? ['--use-env-proxy'] : []),
      resolve(entry),
      '--stdio',
      '--data-dir',
      resolve(dataRoot),
    ],
  };
  return {
    local: {
      cursor: { mcpServers: { wishos: local } },
      'claude-code': { mcpServers: { wishos: local } },
      deepseek: { mcpServers: { wishos: local } },
      workbuddy: { mcpServers: { wishos: { type: 'stdio', ...local } } },
      codex: {
        toml:
          '[mcp_servers.wishos]\ncommand = ' +
          JSON.stringify(process.execPath) +
          '\nargs = ' +
          JSON.stringify(local.args) +
          '\n',
      },
    },
    remote: config.cloud
      ? {
          url: new URL('/mcp', config.cloud.endpoint).toString(),
          authentication: 'OAuth 2.1 with a WishOS pairing code',
          chatgpt:
            'Add the remote MCP URL as a custom plugin; connect using the one-time MCP authorization code from this wizard.',
        }
      : undefined,
    sessions: 'Selected Harness owns its session history and model credentials',
  };
}
