import {
  CodexDictation,
  type CodexSpeechOptions,
  type AccountSpeechAuth,
} from './codex-dictation.js';
import { SpeechUnavailable } from '../speech.js';
import { HarnessTurnEnded } from './errors.js';
import { RpcProcess, HarnessRpcError } from './rpc.js';
import type { HarnessAdapter, AgentEvent } from './types.js';
import { codexUsage } from './usage.js';
import type { HarnessSession, HarnessMessage, HarnessPage } from './sessions.js';

function sessionMetadata(thread: any): HarnessSession {
  if (typeof thread?.id !== 'string' || !thread.id) throw Error('harness_session_identity');
  return {
    id: thread.id,
    title: typeof thread.name === 'string' ? thread.name : '',
    ...(typeof thread.preview === 'string' && thread.preview ? { summary: thread.preview } : {}),
    ...(typeof thread.createdAt === 'number' ? { created_at: thread.createdAt } : {}),
    ...(typeof thread.updatedAt === 'number' ? { updated_at: thread.updatedAt } : {}),
    ...(typeof thread.status?.type === 'string' ? { state: thread.status.type } : {}),
    ...(typeof thread.ephemeral === 'boolean' ? { ephemeral: thread.ephemeral } : {}),
  };
}

export class CodexAdapter implements HarnessAdapter {
  name = 'codex';
  readonly nativeSpeech?: CodexDictation;
  capabilities = { interrupt: true, approval: true, usage: true, steer: true };
  private initialized?: Promise<void>;
  private loaded = new Set<string>();
  private closed = false;
  private tainted = false;
  private active = new Map<string, string>();
  private admission = new Map<string, Promise<void>>();
  private approvals = new Map<
    string,
    { wireId: unknown; timer: NodeJS.Timeout; method: string; params: any }
  >();
  constructor(
    private rpc: RpcProcess,
    private timeoutMs = 600000,
    private threadOptions: Record<string, unknown> = {},
    speechOptions?: CodexSpeechOptions,
  ) {
    rpc.on('closed', () => {
      this.loaded.clear();
      this.initialized = undefined;
    });
    if (speechOptions)
      this.nativeSpeech = new CodexDictation(() => this.speechAuth(), speechOptions);
  }
  private async initialize() {
    if (this.closed) throw Error('Codex adapter closed');
    this.initialized ??= this.rpc
      .request('initialize', { clientInfo: { name: 'wishos-hub', version: '0.5.0' } })
      .then(() => {
        this.rpc.write({ method: 'initialized', params: {} });
      });
    await this.initialized;
  }
  private async speechStatus(args: Record<string, unknown>) {
    try {
      return await this.rpc.request('getAuthStatus', args);
    } catch (error) {
      if (error instanceof HarnessRpcError && error.code === -32601)
        throw new SpeechUnavailable(
          'This Codex runtime does not expose native speech authentication',
        );
      throw error;
    }
  }
  private async speechAuth(): Promise<AccountSpeechAuth> {
    await this.initialize();
    let status = await this.speechStatus({
      includeToken: true,
      refreshToken: false,
    });
    if (
      !['chatgpt', 'chatgptAuthTokens'].includes(status.authMethod) ||
      typeof status.authToken !== 'string'
    )
      throw new SpeechUnavailable('Sign in to ChatGPT for native dictation');
    let claims = JSON.parse(Buffer.from(status.authToken.split('.')[1], 'base64url').toString());
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now() + 60000) {
      status = await this.speechStatus({ includeToken: true, refreshToken: true });
      if (typeof status.authToken !== 'string')
        throw new SpeechUnavailable('Account sign-in expired');
      claims = JSON.parse(Buffer.from(status.authToken.split('.')[1], 'base64url').toString());
    }
    const account = await this.rpc.request('account/read', { refreshToken: false });
    const identity = claims['https://api.openai.com/auth'],
      routing = account.workspaceRouting;
    if (
      !routing ||
      !identity?.chatgpt_account_id ||
      identity.chatgpt_account_id !== routing.chatgptAccountId
    )
      throw new SpeechUnavailable('Speech account routing unavailable');
    return {
      token: status.authToken,
      accountId: identity.chatgpt_account_id,
      backendOrigin: routing.backendOrigin,
      routingOverride: routing.accountRoutingOverride,
      fedramp: identity.chatgpt_account_is_fedramp === true,
    };
  }
  async readUsage(session?: string) {
    await this.initialize();
    return codexUsage(
      await this.rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, 15000),
    );
  }
  async readTools(session: string) {
    await this.open(session);
    const catalog = await this.rpc.request(
      'mcpServerStatus/list',
      { threadId: session, detail: 'toolsAndAuthOnly' },
      30000,
    );
    return {
      harness: 'codex',
      source: 'mcpServerStatus/list',
      session_id: session,
      observed_at: new Date().toISOString(),
      servers: (catalog.data ?? []).map((s: any) => ({
        name: s.name,
        status: s.runtimeStatus,
        error: s.toolsError ?? null,
        tool_count: Object.keys(s.tools ?? {}).length,
        tools: Object.values(s.tools ?? {}).map((t: any) => ({
          name: t.name,
          description: t.description,
          annotations: t.annotations,
        })),
      })),
    };
  }
  async reloadTools() {
    await this.initialize();
    await this.rpc.request('config/mcpServer/reload', {});
    return { refresh_requested: true, harness: 'codex', source: 'config/mcpServer/reload' };
  }
  async listSessions(options: {
    cursor?: string;
    limit: number;
  }): Promise<HarnessPage<HarnessSession>> {
    await this.initialize();
    const r = await this.rpc.request('thread/list', {
      ...(options.cursor ? { cursor: options.cursor } : {}),
      limit: options.limit,
      archived: false,
      modelProviders: [],
    });
    if (!Array.isArray(r.data)) throw Error('harness_session_page');
    return { entries: r.data.map(sessionMetadata), next_cursor: r.nextCursor ?? null };
  }
  async readSession(id: string) {
    await this.initialize();
    const r = await this.rpc.request('thread/read', { threadId: id, includeTurns: false });
    const session = sessionMetadata(r.thread);
    if (session.id !== id) throw Error('harness_session_identity');
    return session;
  }
  async createSession() {
    if (this.closed || this.tainted) throw Error('Codex runtime unavailable');
    await this.initialize();
    const r = await this.rpc.request('thread/start', this.threadOptions);
    const session = sessionMetadata(r.thread);
    this.loaded.add(session.id);
    return session;
  }
  async listMessages(
    id: string,
    options: { cursor?: string; limit: number },
  ): Promise<HarnessPage<HarnessMessage>> {
    await this.initialize();
    // Native display-summary pages avoid full-history hydration and large tool bodies.
    const r = await this.rpc.request('thread/turns/list', {
      threadId: id,
      limit: options.limit,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      itemsView: 'summary',
      sortDirection: 'desc',
    });
    if (!Array.isArray(r.data)) throw Error('harness_message_page');
    const entries: HarnessMessage[] = [];
    for (const turn of r.data)
      for (const item of [...(turn.items ?? [])].reverse()) {
        if (item.type === 'userMessage') {
          const text = (item.content ?? [])
            .filter((c: any) => c.type === 'text' && typeof c.text === 'string')
            .map((c: any) => c.text)
            .join('\n');
          entries.push({
            id: item.id,
            role: 'user',
            text,
            preview: true,
            ...(typeof turn.startedAt === 'number' ? { created_at: turn.startedAt } : {}),
          });
        } else if (
          item.type === 'agentMessage' &&
          [undefined, null, 'final', 'final_answer'].includes(item.phase) &&
          typeof item.text === 'string'
        )
          entries.push({
            id: item.id,
            role: 'assistant',
            text: item.text,
            preview: true,
            ...(typeof turn.completedAt === 'number' ? { created_at: turn.completedAt } : {}),
          });
      }
    return { entries, next_cursor: r.nextCursor ?? null };
  }
  async open(id?: string) {
    if (this.tainted) throw new Error('Codex runtime requires restart after an uncertain run');
    if (!id) return (await this.createSession()).id;
    await this.initialize();
    if (this.loaded.has(id)) return id;
    const r = await this.rpc.request('thread/resume', { ...this.threadOptions, threadId: id });
    if (r.thread?.id !== id) throw new Error('harness_session_identity');
    this.loaded.add(r.thread.id);
    return r.thread.id;
  }
  send(session: string, text: string, emit: (e: AgentEvent) => void): Promise<string> {
    if (this.closed) return Promise.reject(Error('Codex adapter closed'));
    if (this.tainted)
      return Promise.reject(Error('Codex runtime requires restart after an uncertain run'));
    if (this.active.has(session) || this.admission.has(session))
      return Promise.reject(new Error('Codex session already running; use steer'));
    let admitted!: () => void;
    this.admission.set(
      session,
      new Promise<void>((resolve) => {
        admitted = resolve;
      }),
    );
    return new Promise((resolve, reject) => {
      let final = '',
        delta = '',
        done = false;
      let turnId: string | undefined;
      const beforeReceipt: any[] = [];
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (error && !(error instanceof HarnessTurnEnded)) this.tainted = true;
        clearTimeout(timer);
        this.rpc.off('message', message);
        this.rpc.off('closed', closed);
        this.active.delete(session);
        this.admission.delete(session);
        admitted();
        for (const [id, a] of this.approvals)
          if (id.startsWith(session + ':')) {
            clearTimeout(a.timer);
            this.approvals.delete(id);
          }
        error ? reject(error) : resolve(final || delta);
      };
      const closed = (e: Error) => finish(e);
      const message = (m: any) => {
        const p = m.params ?? {};
        if (p.threadId !== session) return;
        if (!turnId) {
          if (beforeReceipt.length >= 256)
            return finish(new Error('too many events before Codex turn receipt'));
          beforeReceipt.push(m);
          return;
        }
        if (
          (p.turnId ?? p.turn?.id) !== turnId &&
          !(m.id !== undefined && p.turnId == null && p.turn == null)
        )
          return;
        if (m.method === 'turn/started' && p.turn?.id) this.active.set(session, p.turn.id);
        if (m.method === 'item/agentMessage/delta') {
          delta += p.delta ?? '';
          emit({ type: 'text', text: p.delta ?? '' });
        }
        if (m.method === 'item/completed' && p.item?.type === 'agentMessage')
          final = String(p.item.text ?? final);
        if (m.method === 'turn/completed')
          finish(
            p.turn?.status === 'completed'
              ? undefined
              : ['failed', 'interrupted'].includes(p.turn?.status)
                ? new HarnessTurnEnded(`Codex turn ${p.turn.status}`, p.turn.status)
                : new Error(`Codex turn ${p.turn?.status ?? 'unknown'}`),
          );
        if (m.id !== undefined) {
          if (
            [
              'item/commandExecution/requestApproval',
              'item/fileChange/requestApproval',
              'item/permissions/requestApproval',
              'mcpServer/elicitation/request',
              'tool/requestUserInput',
              'item/tool/requestUserInput',
            ].includes(m.method)
          ) {
            const id = session + ':' + String(m.id);
            const timer = setTimeout(() => {
              try {
                this.approve(id, false);
              } catch {
                /* transport already closed */
              }
            }, 120000);
            this.approvals.set(id, { wireId: m.id, timer, method: m.method, params: p });
            emit({ type: 'approval', requestId: id, request: { method: m.method, ...p } });
          } else
            this.rpc.write({
              id: m.id,
              error: {
                code: -32601,
                message: 'This client does not support this request; use a full Codex client',
              },
            });
        }
      };
      const timer = setTimeout(() => {
        void this.interrupt(session).catch(() => {});
        finish(new Error('Codex run timeout; interruption requested'));
      }, this.timeoutMs);
      this.rpc.on('message', message);
      this.rpc.on('closed', closed);
      this.rpc.request('turn/start', { threadId: session, input: [{ type: 'text', text }] }).then(
        (r) => {
          if (done) return;
          if (typeof r.turn?.id !== 'string') return finish(new Error('missing Codex turn id'));
          turnId = r.turn.id;
          this.active.set(session, turnId!);
          this.admission.delete(session);
          admitted();
          for (const m of beforeReceipt) {
            if (done) break;
            message(m);
          }
          beforeReceipt.length = 0;
        },
        (e) => finish(e),
      );
    });
  }
  async steer(session: string, text: string): Promise<boolean> {
    await this.admission.get(session);
    const turnId = this.active.get(session);
    if (!turnId) return false;
    try {
      const result = await this.rpc.request('turn/steer', {
        threadId: session,
        expectedTurnId: turnId,
        input: [{ type: 'text', text }],
      });
      if (result.turnId !== turnId) throw Error('Codex returned a different steered turn');
      return true;
    } catch (error) {
      // A native RPC rejection after completion permits a same-session continuation.
      // A timeout/disconnect is uncertain: never replay possibly admitted instructions.
      if (
        error instanceof Error &&
        /^harness RPC error /.test(error.message) &&
        (this.active.get(session) !== turnId ||
          /: no active turn(?: to steer)?$/i.test(error.message))
      )
        return false;
      throw error;
    }
  }
  async interrupt(session: string) {
    const turnId = this.active.get(session);
    if (!turnId) throw new Error('no active turn');
    await this.rpc.request('turn/interrupt', { threadId: session, turnId });
  }
  approve(id: string, accept: boolean, content?: unknown) {
    const a = this.approvals.get(id);
    if (!a) throw new Error('approval expired or already resolved');
    let result: any;
    if (a.method === 'item/permissions/requestApproval') {
      result = { permissions: accept ? (a.params.permissions ?? {}) : {}, scope: 'turn' };
    } else if (a.method === 'mcpServer/elicitation/request') {
      const schema = a.params.requestedSchema;
      if (
        accept &&
        content === undefined &&
        schema?.type === 'object' &&
        schema.properties &&
        !Object.keys(schema.properties).length &&
        !schema.required?.length
      )
        content = {};
      if (
        accept &&
        a.params.mode !== 'url' &&
        (!content || typeof content !== 'object' || Array.isArray(content))
      )
        throw new Error('Form authorization requires structured user input');
      result = {
        action: accept ? 'accept' : 'decline',
        content: accept ? (content ?? null) : null,
      };
    } else if (['tool/requestUserInput', 'item/tool/requestUserInput'].includes(a.method)) {
      if (accept && (!content || typeof content !== 'object' || !(content as any).answers))
        throw new Error('User-input request requires answers');
      result = accept ? content : { answers: {} };
    } else result = { decision: accept ? 'accept' : 'decline' };
    clearTimeout(a.timer);
    this.approvals.delete(id);
    this.rpc.write({ id: a.wireId, result });
  }
  async close() {
    this.closed = true;
    this.loaded.clear();
    for (const a of this.approvals.values()) clearTimeout(a.timer);
    this.approvals.clear();
    await this.rpc.close();
  }
}
