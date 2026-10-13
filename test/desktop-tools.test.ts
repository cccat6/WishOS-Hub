import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { desktopToolsBridge } from '../src/adapters/desktop-tools.js';
import { codexThreadOptions } from '../src/adapters/codex-options.js';

test('headless/disabled Desktop tools leave ordinary Harness tools intact', () => {
  assert.equal(desktopToolsBridge(false, {}), null);
  assert.equal(desktopToolsBridge(undefined, {}), null);
  assert.equal(desktopToolsBridge({ enabled: false, pipePath: '/missing' }, {}), null);
});
test('official Desktop bridge imports its whole tool catalog and supplied approval policies', async () => {
  if (process.platform === 'win32') return;
  const dir = await mkdtemp(join(tmpdir(), 'notes-desktop-'));
  const plugin = join(dir, 'plugins/openai-bundled/plugins/codex-app-tools');
  const runtime = join(dir, 'cua_node/bin/node');
  const pipe = join(dir, 'host.sock');
  const server = createServer((socket) => socket.end());
  try {
    await mkdir(plugin, { recursive: true });
    await mkdir(join(dir, 'cua_node/bin'), { recursive: true });
    await writeFile(runtime, 'fixture');
    await writeFile(join(plugin, 'server.mjs'), 'fixture');
    await writeFile(
      join(plugin, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          codex_app: {
            tools: { send_message_to_thread: { approval_mode: 'prompt' } },
            tool_timeout_sec: 3600,
          },
        },
      }),
    );
    await new Promise<void>((r) => server.listen(pipe, r));
    const bridge = desktopToolsBridge(undefined, {
      CODEX_APP_TOOLS_PIPE_PATH: pipe,
      CODEX_MCP_NODE_PATH: runtime,
    });
    assert.ok(bridge);
    assert.equal(bridge.runtime, realpathSync(runtime));
    assert.deepEqual(bridge.server.args, [join(plugin, 'server.mjs')]);
    assert.deepEqual(bridge.server.tools, { send_message_to_thread: { approval_mode: 'prompt' } });
    const options = codexThreadOptions(
      '/project',
      'http://127.0.0.1/mcp',
      'TOKEN',
      'skill',
      { config: { mcp_servers: { existing: { command: 'old' } } } },
      bridge.server,
    );
    assert.equal(options.config.mcp_servers.existing.command, 'old');
    assert.equal(options.config.mcp_servers.notes_desktop.command, runtime);
    assert.equal(options.config.mcp_servers.notes_desktop.enabled_tools, undefined);
    assert.ok(options.config.mcp_servers.agentic_notes);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
