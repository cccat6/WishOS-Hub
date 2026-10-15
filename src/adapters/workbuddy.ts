import type { HarnessAdapter, AgentEvent } from './types.js';
import { AcpAdapter } from './acp.js';
import { SseRpc } from './sse-rpc.js';
import { boundedJson } from './runner-http.js';
export class WorkBuddyAdapter implements HarnessAdapter {
  readonly name = 'workbuddy';
  readonly capabilities = { interrupt: true, approval: true, steer: false };
  private sessions = new Map<string, AcpAdapter>();
  constructor(
    private options: {
      endpoint: string;
      authTokenEnv?: string;
      cwd: string;
      timeoutMs: number;
      mcpServers?: unknown[];
    },
    private fetcher: typeof fetch = fetch,
  ) {}
  private headers() {
    const token = this.options.authTokenEnv ? process.env[this.options.authTokenEnv] : undefined;
    if (!token) throw Error('workbuddy_authorization_required');
    return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  }
  async open(nativeId?: string) {
    if (!nativeId) throw Error('workbuddy_select_task_first');
    if (this.sessions.has(nativeId)) return nativeId;
    const task = await boundedJson(
      await this.fetcher(
        new URL('/openapi/v2/tasks/' + encodeURIComponent(nativeId), this.options.endpoint),
        { headers: this.headers(), signal: AbortSignal.timeout(20000) },
      ),
    );
    if (
      task.task_id !== nativeId ||
      typeof task.link !== 'string' ||
      typeof task.token !== 'string'
    )
      throw Error('workbuddy_task_not_ready');
    const link = new URL(task.link);
    if (link.protocol !== 'https:' && link.hostname !== '127.0.0.1')
      throw Error('workbuddy_acp_transport');
    const adapter = new AcpAdapter(
      'workbuddy',
      new SseRpc(link.toString(), task.token, this.fetcher),
      {
        cwd: this.options.cwd,
        timeoutMs: this.options.timeoutMs,
        mcpServers: this.options.mcpServers,
      },
    );
    try {
      await adapter.open(nativeId);
    } catch (e) {
      await adapter.close();
      throw e;
    }
    this.sessions.set(nativeId, adapter);
    return nativeId;
  }
  async send(session: string, text: string, emit: (e: AgentEvent) => void) {
    await this.open(session);
    return this.sessions.get(session)!.send(session, text, emit);
  }
  async interrupt(session: string) {
    await this.sessions.get(session)?.interrupt(session);
  }
  approve(id: string, accept: boolean) {
    for (const adapter of this.sessions.values()) adapter.approve(id, accept);
  }
  async close() {
    await Promise.allSettled([...this.sessions.values()].map((a) => a.close()));
    this.sessions.clear();
  }
}
