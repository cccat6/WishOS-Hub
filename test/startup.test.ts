import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
test('public Node entrypoint starts outside checkout, serves setup and stops by its own identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wishos-startup-')),
    entry = process.env.WISHOS_TEST_ENTRY ?? fileURLToPath(new URL('../dist/connect/cli.js', import.meta.url)),
    child = spawn(
      process.execPath,
      [entry, 'serve', '--data-dir', root, '--host', '127.0.0.1', '--port', '0', '--no-browser'],
      { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const exit = once(child, 'exit');
  let errors = '';
  child.stderr.on('data', (b) => (errors += b));
  try {
    let info: any;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error('startup exited: ' + errors);
      try {
        info = JSON.parse(await readFile(join(root, 'running.json'), 'utf8'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    assert(info, 'startup timeout: ' + errors);
    const base = 'http://127.0.0.1:' + info.port;
    assert((await (await fetch(base + '/healthz')).json()).ok);
    assert.match(await (await fetch(base)).text(), /WishOS/);
    const status = JSON.parse(
      execFileSync(process.execPath, [entry, 'status', '--data-dir', root], { encoding: 'utf8' }),
    );
    assert.equal(status.id, info.id);
    // Async child: stop polls this HTTP process, so blocking execFileSync would deadlock it.
    const stop = spawn(process.execPath, [entry, 'stop', '--data-dir', root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal((await once(stop, 'exit'))[0], 0);
    assert.equal((await exit)[0], 0);
  } finally {
    child.kill('SIGTERM');
    await exit;
    await rm(root, { recursive: true, force: true });
  }
});

test('stdio auto-starts a user connector, keeps stdout protocol-only and preserves proxy access in its child', async () => {
  const { createServer } = await import('node:http');
  const { ConfigStore } = await import('../src/connect/config.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  let requests = 0;
  const proxy = createServer((req, res) => {
    assert.equal(req.url, 'http://wishos.fixture/asset');
    requests++;
    res.end('proxy fixture');
  });
  proxy.on('connect', (req, socket) => {
    assert.equal(req.url, 'wishos.fixture:80');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', (data) => {
      assert.match(data.toString(), /^GET \/asset HTTP\/1\.1/);
      requests++;
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nproxy fixture');
    });
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const root = await mkdtemp(join(tmpdir(), 'wishos-stdio-')),
    entry = process.env.WISHOS_TEST_ENTRY ?? fileURLToPath(new URL('../dist/connect/cli.js', import.meta.url)),
    settings = new ConfigStore(root),
    config = await settings.load();
  await settings.save({ ...config, host: '127.0.0.1', port: 0, mdns: false });
  const proxyUrl = 'http://127.0.0.1:' + (proxy.address() as any).port,
    env = {
      ...process.env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    };
  delete env.NODE_USE_ENV_PROXY;
  const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--use-env-proxy', entry, '--stdio', '--data-dir', root],
      env,
      stderr: 'pipe',
    }),
    client = new Client({ name: 'stdio-regression', version: '1' });
  let errors = '';
  transport.stderr?.on('data', (b) => (errors += b));
  try {
    await client.connect(transport);
    assert((await client.listTools()).tools.some((t) => t.name === 'invoke_resource'));
    const staged: any = await client.callTool({
      name: 'stage_resource',
      arguments: { url: 'http://wishos.fixture/asset', limit_bytes: 64 },
    });
    const job = JSON.parse(staged.content[0].text);
    let done: any;
    for (let i = 0; i < 100; i++) {
      const reply: any = await client.callTool({
        name: 'read_resource_job',
        arguments: { id: job.id },
      });
      done = JSON.parse(reply.content[0].text);
      if (done.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(done.state, 'completed', errors + JSON.stringify(done));
    assert.equal(done.result.size, 13);
    assert.equal(requests, 1);
  } finally {
    await client.close();
    execFileSync(process.execPath, [entry, 'stop', '--data-dir', root], { env, stdio: 'pipe' });
    await new Promise<void>((r) => proxy.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
