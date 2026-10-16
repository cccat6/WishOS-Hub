import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import type { HarnessAdapter } from '../adapters/types.js';
import { CodexAdapter } from '../adapters/codex.js';
import { RpcProcess } from '../adapters/rpc.js';
import { AcpAdapter } from '../adapters/acp.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { RunnerHttpAdapter } from '../adapters/runner-http.js';
import { WorkBuddyAdapter } from '../adapters/workbuddy.js';
import type { RuntimeConfig } from './config.js';
export class UnboundRuntime implements HarnessAdapter {
  readonly name = 'unbound';
  readonly capabilities = { interrupt: false, approval: false };
  async open(): Promise<string> {
    throw Error('harness_binding_required');
  }
  async send(): Promise<string> {
    throw Error('harness_binding_required');
  }
  async close() {}
}
const desktopPackages = [
  {
    info: '/Applications/Codex.app/Contents/Info.plist',
    command: '/Applications/Codex.app/Contents/Resources/bin/codex',
  },
  {
    info: '/Applications/ChatGPT.app/Contents/Info.plist',
    command:
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  },
];
export function detectedCodexSpeech(infoFiles?: string[]) {
  const version = process.env.CODEX_APP_VERSION;
  if (version && /^[0-9.]+$/.test(version)) return { appVersion: version };
  for (const file of infoFiles ??
    (process.platform === 'darwin' ? desktopPackages.map((p) => p.info) : [])) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8'),
      found = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([0-9.]+)<\/string>/);
    if (found) return { appVersion: found[1]! };
    if (process.platform === 'darwin')
      try {
        const value = execFileSync(
          '/usr/bin/plutil',
          ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', file],
          { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        if (/^[0-9.]+$/.test(value)) return { appVersion: value };
      } catch {}
  }
  return undefined;
}
export function createRuntime(
  config: RuntimeConfig,
  bridge: { url: string; token: string; mcpConfig: string },
): HarnessAdapter {
  const cwd = config.cwd ?? homedir(),
    mcpServers = [
      {
        type: 'http',
        name: 'wishos',
        url: bridge.url,
        headers: [{ name: 'Authorization', value: 'Bearer ' + bridge.token }],
      },
    ];
  if (config.kind === 'codex')
    return new CodexAdapter(
      new RpcProcess(
        config.command ??
          (process.platform === 'darwin'
            ? desktopPackages.find((p) => existsSync(p.command))?.command
            : undefined) ??
          'codex',
        config.args ?? ['app-server'],
        cwd,
      ),
      config.timeoutMs,
      {
        cwd,
        ...(config.approvalsReviewer ? { approvalsReviewer: config.approvalsReviewer } : {}),
        config: {
          mcp_servers: {
            wishos: { url: bridge.url, http_headers: { Authorization: 'Bearer ' + bridge.token } },
          },
        },
      },
      config.nativeSpeech ?? detectedCodexSpeech(),
    );
  if (config.kind === 'claude-code')
    return new ClaudeCodeAdapter({
      command: config.command,
      args: config.args,
      cwd,
      timeoutMs: config.timeoutMs,
      mcpConfig: bridge.mcpConfig,
    });
  if (config.kind === 'cursor' || config.kind === 'deepseek')
    return new AcpAdapter(
      config.kind,
      new RpcProcess(
        config.command ?? (config.kind === 'cursor' ? 'agent' : 'dsh'),
        config.args ??
          (config.kind === 'cursor' ? ['acp'] : ['--profile', config.profile ?? 'acp']),
        cwd,
        true,
        config.home ? { DSH_HOME: config.home } : {},
      ),
      {
        cwd,
        timeoutMs: config.timeoutMs,
        mcpServers,
        resumeMethod: config.kind === 'deepseek' ? 'session/resume' : 'session/load',
      },
    );
  if (config.kind === 'workbuddy')
    return new WorkBuddyAdapter({
      endpoint: config.endpoint!,
      authTokenEnv: config.authTokenEnv,
      cwd,
      timeoutMs: config.timeoutMs,
      mcpServers,
    });
  return new RunnerHttpAdapter(config.kind, {
    endpoint: config.endpoint!,
    authTokenEnv: config.authTokenEnv,
    timeoutMs: config.timeoutMs,
  });
}
