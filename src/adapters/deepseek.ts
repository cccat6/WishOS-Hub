import { RpcProcess } from './rpc.js';
import { randomUUID } from 'node:crypto';
import type { HarnessAdapter, AgentEvent } from './types.js';

// SDK protocol pinned in docs/harness-compatibility.md. One prompt at a time per session.
export class DeepSeekAdapter implements HarnessAdapter {
  name = 'deepseek';
  capabilities = { interrupt: false, approval: false };
  private initialized?: Promise<any>;
  private tainted = false;
  constructor(
    private rpc: RpcProcess,
    private initializeParams: Record<string, unknown>,
    private timeoutMs = 600000,
  ) {}
  async open(id?: string) {
    if (this.tainted) throw new Error('DeepSeek runtime requires restart after an uncertain run');
    this.initialized ??= this.rpc.request('initialize', this.initializeParams);
    await this.initialized;
    return id ?? randomUUID();
  }
  async send(session: string, text: string, emit: (e: AgentEvent) => void): Promise<string> {
    // Do not derive completion from an idle event that predates the admitted message.
    return new Promise((resolve, reject) => {
      let messageId: string | undefined,
        admitted = false,
        final = '',
        done = false;
      const receipts = new Set<string>();
      let lastStatus = '';
      const finish = (e?: Error) => {
        if (done) return;
        done = true;
        if (e) this.tainted = true;
        clearTimeout(timer);
        this.rpc.off('message', message);
        this.rpc.off('closed', closed);
        e ? reject(e) : resolve(final);
      };
      const closed = (e: Error) => finish(e);
      const check = () => {
        if (messageId && receipts.has(messageId)) admitted = true;
        if (admitted && lastStatus === 'idle') finish();
      };
      const message = (m: any) => {
        const p = m.params ?? {};
        if (p.sessionId !== session) return;
        if (m.method === 'session.status') {
          lastStatus = p.status;
          emit({ type: 'status', text: p.status });
          check();
        }
        if (m.method === 'session.event') {
          const e = p.event;
          if (e?.type === 'agent/inbox/spliced') {
            for (const item of e.data?.inserted ?? [])
              if (typeof item.id === 'string') receipts.add(item.id);
            lastStatus = 'running';
            check();
          }
          if (e?.type === 'assistant/message') {
            if (!Array.isArray(e.data?.message?.content))
              return finish(new Error('invalid DeepSeek assistant event'));
            final = e.data.message.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('')
              .slice(0, 64000);
            emit({ type: 'text', text: final });
          }
          if (e?.type === 'turn/end' && e.data?.reason?.kind !== 'completed')
            finish(new Error('DeepSeek turn ended without completion'));
          if (e?.type === 'error') finish(new Error('DeepSeek runtime error'));
        }
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              'DeepSeek timeout; native cancellation unsupported, inspect runtime before another run',
            ),
          ),
        this.timeoutMs,
      );
      this.rpc.on('message', message);
      this.rpc.on('closed', closed);
      this.rpc
        .request('session/prompt', { sessionId: session, contentBlocks: [{ type: 'text', text }] })
        .then(
          (r) => {
            if (typeof r.messageId !== 'string')
              return finish(new Error('missing DeepSeek enqueue receipt'));
            messageId = r.messageId;
            check();
          },
          (e) => finish(e),
        );
    });
  }
  async close() {
    await this.rpc.close();
  }
}
