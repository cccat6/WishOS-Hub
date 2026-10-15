import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { HarnessAdapter, AgentEvent } from './types.js';
/** Native CLI keeps its own credentials, tools and transcript. WishOS stores only
 * the binding; no message history is replayed into a fabricated replacement. */
export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name = 'claude-code';
  readonly capabilities = { interrupt: true, approval: false, steer: false };
  private resumed = new Set<string>();
  private running = new Map<string, ChildProcessWithoutNullStreams>();
  constructor(
    private options: {
      command?: string;
      args?: string[];
      cwd: string;
      timeoutMs: number;
      mcpConfig?: string;
    },
  ) {}
  async open(nativeId?: string) {
    const id = nativeId ?? randomUUID();
    if (nativeId) this.resumed.add(id);
    return id;
  }
  async send(session: string, text: string, emit: (event: AgentEvent) => void) {
    if (this.running.has(session)) throw Error('harness_session_busy');
    const args = [
      ...(this.options.args ?? []),
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(this.resumed.has(session) ? ['--resume', session] : ['--session-id', session]),
      ...(this.options.mcpConfig ? ['--mcp-config', this.options.mcpConfig] : []),
    ];
    const child = spawn(this.options.command ?? 'claude', args, {
      cwd: this.options.cwd,
      stdio: 'pipe',
      shell: false,
    });
    this.running.set(session, child);
    const exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    let input = '',
      final: string | undefined,
      error = false,
      bytes = 0;
    try {
      return await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(Error('harness_outcome_unknown'));
        }, this.options.timeoutMs);
        child.once('error', () => {
          clearTimeout(timeout);
          reject(Error('harness_process_unavailable'));
        });
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => {});
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (data: string) => {
          bytes += Buffer.byteLength(data);
          if (bytes > 4 * 1024 * 1024) {
            child.kill();
            reject(Error('harness_output_limit'));
            return;
          }
          input += data;
          for (;;) {
            const end = input.indexOf('\n');
            if (end < 0) break;
            const line = input.slice(0, end);
            input = input.slice(end + 1);
            if (!line.trim()) continue;
            let m: any;
            try {
              m = JSON.parse(line);
            } catch {
              child.kill();
              reject(Error('harness_protocol'));
              return;
            }
            if (m.session_id && m.session_id !== session) {
              child.kill();
              reject(Error('harness_session_mismatch'));
              return;
            }
            if (m.type === 'system' && m.subtype === 'init') {
              this.resumed.add(session);
              emit({ type: 'status', text: 'running' });
            }
            if (m.type === 'assistant') {
              for (const c of m.message?.content ?? [])
                if (c.type === 'text') emit({ type: 'text', text: c.text });
            }
            if (m.type === 'result') {
              error = m.is_error === true || m.subtype !== 'success';
              final =
                typeof m.result === 'string' ? m.result : JSON.stringify(m.structured_output ?? {});
            }
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          if (code !== 0 || error || final === undefined) reject(Error('harness_run_failed'));
          else resolve(final);
        });
        child.stdin.end(text);
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const hardStop = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(hardStop);
      if (this.running.get(session) === child) this.running.delete(session);
    }
  }
  async interrupt(session: string) {
    this.running.get(session)?.kill('SIGINT');
  }
  async close() {
    await Promise.all(
      [...this.running.values()].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
            child.once('close', () => {
              clearTimeout(timeout);
              resolve();
            });
            child.kill('SIGTERM');
          }),
      ),
    );
  }
}
