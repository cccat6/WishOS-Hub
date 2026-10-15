import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class HarnessRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

// Exact executable/args are administrator configuration, never a shell command built from speech.
export class RpcProcess extends EventEmitter {
  child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private input = '';
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    private command: string,
    private args: string[],
    private cwd: string,
    private jsonrpc = false,
    private environment: NodeJS.ProcessEnv = {},
  ) {
    super();
  }
  start() {
    if (this.child) return;
    this.input = '';
    const child = (this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: 'pipe',
      shell: false,
      env: { ...process.env, ...this.environment },
    }));
    child.stdin.on('error', (e) => this.fail(e));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.input += chunk;
      if (this.input.length > 4 * 1024 * 1024) {
        child.kill();
        return this.fail(new Error('harness frame exceeds limit'));
      }
      for (;;) {
        const n = this.input.indexOf('\n');
        if (n < 0) break;
        const line = this.input.slice(0, n);
        this.input = this.input.slice(n + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          this.fail(new Error('invalid harness JSON'));
          child.kill();
          return;
        }
        if (msg.method) this.emit('message', msg);
        else if (typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          msg.error
            ? p.reject(
                new HarnessRpcError(
                  msg.error.code,
                  `harness RPC error ${msg.error.code}: ${String(msg.error.message).slice(0, 300)}`,
                ),
              )
            : p.resolve(msg.result);
        }
      }
    });
    // Drain stderr but do not expose credentials, prompts or private tool output in hub logs.
    child.stderr.on('data', () => {});
    child.once('error', (e) => this.fail(e));
    child.once('exit', () => {
      if (this.child === child) this.child = undefined;
      this.fail(new Error('harness process exited'));
    });
  }
  private fail(e: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.emit('closed', e);
  }
  write(msg: any) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('harness not running');
    this.child.stdin.write(JSON.stringify(this.jsonrpc ? { jsonrpc: '2.0', ...msg } : msg) + '\n');
  }
  request(method: string, params: unknown, timeout = 30000): Promise<any> {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async close() {
    const c = this.child;
    if (!c) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => c.kill('SIGKILL'), 1500);
      c.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      c.stdin.end();
      c.kill('SIGTERM');
    });
  }
}
