import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type DesktopToolsOptions =
  | boolean
  | { enabled?: boolean; resourcesPath?: string; pipePath?: string };
export interface DesktopToolsBridge {
  runtime: string;
  resources: string;
  server: Record<string, unknown>;
  additionalServers: Record<string, Record<string, unknown>>;
}
export function desktopToolsBridge(
  options: DesktopToolsOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DesktopToolsBridge | null {
  if (options === false || (typeof options === 'object' && options.enabled === false)) return null;
  const settings = typeof options === 'object' ? options : {};
  const pipe = settings.pipePath ?? env.CODEX_APP_TOOLS_PIPE_PATH;
  if (!pipe) return null;
  if (process.platform !== 'win32' && (!existsSync(pipe) || !statSync(pipe).isSocket()))
    return null;
  const roots: string[] = [];
  if (settings.resourcesPath) roots.push(resolve(settings.resourcesPath));
  if (env.CODEX_ELECTRON_RESOURCES_PATH) roots.push(env.CODEX_ELECTRON_RESOURCES_PATH);
  for (const file of [env.CODEX_MCP_NODE_PATH, env.CODEX_CLI_PATH]) {
    if (!file) continue;
    let at = dirname(file);
    for (let i = 0; i < 7; i++) {
      roots.push(at);
      const parent = dirname(at);
      if (parent === at) break;
      at = parent;
    }
  }
  for (const resources of [...new Set(roots)]) {
    const plugin = join(resources, 'plugins/openai-bundled/plugins/codex-app-tools');
    const runtime = join(
      resources,
      'cua_node/bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    const script = join(plugin, 'server.mjs');
    if (!existsSync(runtime) || !existsSync(script)) continue;
    const supplied = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')).mcpServers
      .codex_app;
    const reviewRoot = join(resources, 'plugins/openai-bundled/plugins/code-review');
    const additionalServers: Record<string, Record<string, unknown>> = {};
    if (existsSync(join(reviewRoot, 'server.mjs')) && existsSync(join(reviewRoot, '.mcp.json'))) {
      const review = JSON.parse(readFileSync(join(reviewRoot, '.mcp.json'), 'utf8')).mcpServers[
        'code-review'
      ];
      additionalServers.notes_code_review = {
        command: runtime,
        args: [join(reviewRoot, 'server.mjs')],
        cwd: reviewRoot,
        enabled: true,
        env_vars: review.env_vars ?? [],
        tools: review.tools ?? {},
        tool_timeout_sec: review.tool_timeout_sec ?? 120,
      };
    }
    return {
      runtime: realpathSync(runtime),
      resources,
      additionalServers,
      server: {
        command: runtime,
        args: [script],
        cwd: plugin,
        enabled: true,
        env: { CODEX_APP_TOOLS_PIPE_PATH: pipe },
        startup_timeout_sec: 15,
        tool_timeout_sec: supplied.tool_timeout_sec ?? 3600,
        default_tools_approval_mode: supplied.default_tools_approval_mode ?? 'approve',
        tools: supplied.tools ?? {},
      },
    };
  }
  return null;
}

// The desktop pipe validates caller signing identity on macOS. Replace this
// process with the app's supplied signed runtime; never alter the peer checks.
export function useDesktopRuntime(bridge: DesktopToolsBridge | null) {
  if (!bridge || process.platform !== 'darwin') return;
  if (realpathSync(process.execPath) === bridge.runtime) {
    process.env.NOTES_DESKTOP_SIGNED_RUNTIME = '1';
    return;
  }
  process.env.NOTES_RENDER_NODE ??= process.execPath;
  process.env.NOTES_DESKTOP_SIGNED_RUNTIME = '1';
  const execve = (process as any).execve;
  if (typeof execve !== 'function')
    throw Error(`Desktop tools require launching Hub with ${bridge.runtime}`);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === 'string'),
  );
  execve(bridge.runtime, [bridge.runtime, ...process.argv.slice(1)], env);
}
