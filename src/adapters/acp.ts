import type { HarnessAdapter, AgentEvent } from './types.js';
import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HarnessTurnEnded } from './errors.js';
export interface AgentRpc extends EventEmitter {
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  write(message: any): void;
  close(): Promise<void>;
}
export class AcpAdapter implements HarnessAdapter {
  readonly capabilities = { interrupt: true, approval: true, steer: false };
  private identity = randomUUID();
  private initialized?: Promise<any>;
  private active = new Map<string, { emit: (event: AgentEvent) => void; text: string }>();
  private approvals = new Map<
    string,
    { wire: unknown; session: string; options: { optionId: string; kind: string }[] }
  >();
  constructor(
    readonly name: string,
    private rpc: AgentRpc,
    private options: {
      cwd: string;
      timeoutMs: number;
      mcpServers?: unknown[];
      resumeMethod?: 'session/load' | 'session/resume';
    },
  ) {
    rpc.on('message', (m) => this.message(m));
  }
  private message(m: any) {
    const p = m.params ?? {},
      run = this.active.get(p.sessionId);
    if (m.method === 'session/update' && run) {
      const update = p.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        run.text += update.content.text;
        run.emit({ type: 'text', text: update.content.text });
      } else if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate))
        run.emit({ type: 'status', text: 'tool' });
    }
    if (m.method === 'session/request_permission' && m.id !== undefined) {
      if (!run) {
        this.rpc.write({ id: m.id, result: { outcome: { outcome: 'cancelled' } } });
        return;
      }
      const id = this.identity + ':' + String(m.id);
      this.approvals.set(id, { wire: m.id, session: p.sessionId, options: p.options ?? [] });
      run.emit({
        type: 'approval',
        requestId: id,
        request: {
          kind: 'tool_permission',
          session_id: p.sessionId,
          tool: p.toolCall,
          options: p.options,
        },
      });
    } else if (m.id !== undefined && m.method && m.method !== 'session/request_permission')
      this.rpc.write({
        id: m.id,
        error: { code: -32601, message: 'Client capability not available' },
      });
  }
  private initialize() {
    return (this.initialized ??= this.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'wishos-hub', version: '0.5.0' },
    }));
  }
  async open(nativeId?: string) {
    const init = await this.initialize();
    const method = nativeId ? (this.options.resumeMethod ?? 'session/load') : 'session/new';
    if (
      nativeId &&
      method === 'session/resume' &&
      !init.agentCapabilities?.sessionCapabilities?.resume
    )
      throw Error('harness_resume_not_advertised');
    const result = await this.rpc.request(
      method,
      {
        ...(nativeId ? { sessionId: nativeId } : {}),
        cwd: this.options.cwd,
        mcpServers: this.options.mcpServers ?? [],
      },
      this.options.timeoutMs,
    );
    const id = result.sessionId ?? nativeId;
    if (typeof id !== 'string' || !id) throw Error('harness_session_identity');
    return id;
  }
  async send(session: string, text: string, emit: (event: AgentEvent) => void) {
    if (this.active.has(session)) throw Error('harness_session_busy');
    const run = { emit, text: '' };
    this.active.set(session, run);
    try {
      const result = await this.rpc.request(
        'session/prompt',
        { sessionId: session, prompt: [{ type: 'text', text }] },
        this.options.timeoutMs,
      );
      if (result.stopReason === 'cancelled')
        throw new HarnessTurnEnded('harness_turn_cancelled', 'interrupted');
      if (result.stopReason !== 'end_turn')
        throw Error('harness_turn_' + String(result.stopReason ?? 'incomplete'));
      return run.text;
    } finally {
      this.active.delete(session);
      for (const [id, p] of this.approvals) {
        if (p.session !== session) continue;
        this.rpc.write({ id: p.wire, result: { outcome: { outcome: 'cancelled' } } });
        this.approvals.delete(id);
      }
    }
  }
  async interrupt(session: string) {
    if (this.active.has(session))
      this.rpc.write({ method: 'session/cancel', params: { sessionId: session } });
  }
  approve(id: string, accept: boolean) {
    const pending = this.approvals.get(id);
    if (!pending) return;
    this.approvals.delete(id);
    const selected = pending.options.find((o) =>
      accept ? o.kind === 'allow_once' : o.kind === 'reject_once',
    );
    this.rpc.write({
      id: pending.wire,
      result: {
        outcome: selected
          ? { outcome: 'selected', optionId: selected.optionId }
          : { outcome: 'cancelled' },
      },
    });
  }
  async close() {
    await this.rpc.close();
    this.active.clear();
    this.approvals.clear();
  }
}
