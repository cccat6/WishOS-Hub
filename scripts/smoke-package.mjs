import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export async function smokePackage(root) {
  const parserUrl = pathToFileURL(join(root, 'dist/node-lua-compiler.js')).href;
  execFileSync(
    join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
    [
      '--input-type=module',
      '-e',
      `const {nodeLuaCompiler}=await import(${JSON.stringify(parserUrl)});const compiler=await nodeLuaCompiler();if(!compiler.check('local x <const> = 1; return x','ok.lua').ok||compiler.check('return {','bad.lua').ok)throw Error('packaged_lua_parser');`,
    ],
    { cwd: tmpdir(), stdio: 'inherit' },
  );
  const data = await mkdtemp(join(tmpdir(), 'wishos-package-'));
  const child = spawn(
    join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
    [
      join(root, 'dist/connect/cli.js'),
      'serve',
      '--data-dir',
      data,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--no-browser',
    ],
    { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let errors = '';
  child.stderr.on('data', (c) => {
    errors += c;
    if (errors.length > 4000) errors = errors.slice(-4000);
  });
  const exit = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  try {
    const until = Date.now() + 20000;
    let info;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw Error('Package exited: ' + errors);
      try {
        info = JSON.parse(await readFile(join(data, 'running.json'), 'utf8'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert(info, 'Packaged service did not start: ' + errors);
    const base = 'http://127.0.0.1:' + info.port,
      health = await (await fetch(base + '/healthz')).json();
    assert(health.ok);
    const page = await fetch(base),
      cookie = page.headers.get('set-cookie').split(';')[0];
    assert((await page.text()).includes('WishOS'));
    const state = await (
      await fetch(base + '/setup/api/state', { headers: { Cookie: cookie } })
    ).json();
    assert.equal(state.config.devices.length, 0);
    assert(!state.config.localToken);
    const config = JSON.parse(await readFile(join(data, 'connector.json'), 'utf8'));
    const response = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.localToken,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'package-smoke', version: '1' },
        },
      }),
    });
    assert(response.ok);
    const decodeMcp = (text) => {
      const data = text.trim().startsWith('{')
        ? text
        : text
            .split('\n')
            .find((line) => line.startsWith('data:'))
            ?.slice(5)
            .trim();
      assert(data, 'Packaged MCP response missing data');
      const message = JSON.parse(data);
      assert(!message.error, JSON.stringify(message.error));
      return message.result;
    };
    const initialized = decodeMcp(await response.text());
    assert(initialized.protocolVersion);
    const { authoringInstructions } = await import(
      pathToFileURL(join(root, 'dist/guidance.js')).href
    );
    assert(initialized.instructions.includes(authoringInstructions()));
    let requestId = 1;
    const mcp = async (method, params) => {
      const reply = await fetch(base + '/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.localToken,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': initialized.protocolVersion,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      });
      assert(reply.ok);
      return decodeMcp(await reply.text());
    };
    // Exercise compiled guidance from an external cwd, without a local Skill install.
    const index = await mcp('tools/call', { name: 'get_guidance', arguments: {} });
    const catalog = JSON.parse(index.content[0].text);
    const entry = catalog.references.find((r) => r.id === catalog.authoring.component_id);
    const toolGuide = await mcp('tools/call', {
      name: 'get_guidance',
      arguments: { component_id: entry.id },
    });
    assert(!toolGuide.isError);
    const source = await readFile(join(root, entry.source.path), 'utf8');
    assert.equal(toolGuide.content[0].resource.text, source);
    assert.equal(createHash('sha256').update(source).digest('hex'), entry.sha256);
    const resourceGuide = await mcp('resources/read', { uri: entry.uri });
    assert.equal(resourceGuide.contents[0].text, source);
    console.log(
      JSON.stringify({
        package_smoke: true,
        platform: process.platform,
        arch: process.arch,
        external_cwd: true,
        python_required: false,
        checks: [
          'bundled-runtime',
          'http',
          'wizard',
          'authenticated-mcp',
          'stock-lua-wasm',
          'authoring-guidance-resource-and-tool',
        ],
      }),
    );
    execFileSync(
      join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
      [join(root, 'dist/connect/cli.js'), 'stop', '--data-dir', data],
      { stdio: 'inherit' },
    );
  } finally {
    child.kill('SIGTERM');
    const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit;
    clearTimeout(hard);
    await rm(data, { recursive: true, force: true });
  }
}
if (process.argv[2]) await smokePackage(resolve(process.argv[2]));
