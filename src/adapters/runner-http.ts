import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { HarnessAdapter, AgentEvent } from './types.js';
export async function boundedJson(response: Response, limit = 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('runner_empty_response');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw Error('runner_response_limit');
      }
      chunks.push(r.value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!response.ok) {
    const e = Error('runner_http_' + response.status);
    (e as any).status = response.status;
    throw e;
  }
  return data;
}
export class RunnerHttpAdapter implements HarnessAdapter {
  get capabilities() {
    return { interrupt: this.name === 'hermes', approval: false, steer: false };
  }
  private active = new Map<string, { abort: AbortController; done: Promise<void>; run?: string }>();
  constructor(
    readonly name: 'openclaw' | 'hermes',
    private options: { endpoint: string; authTokenEnv?: string; timeoutMs: number },
    private fetcher: typeof fetch = fetch,
  ) {}
  private headers() {
    const key = this.options.authTokenEnv ? process.env[this.options.authTokenEnv] : undefined;
    if (this.options.authTokenEnv && !key) throw Error('runner_authorization_missing');
    return {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: 'Bearer ' + key } : {}),
    };
  }
  async open(nativeId?: string) {
    return nativeId ?? 'wishos-' + randomUUID();
  }
  async send(session: string, text: string, emit: (event: AgentEvent) => void) {
    if (this.active.has(session)) throw Error('harness_session_busy');
    const headers = this.headers();
    const abort = new AbortController();
    let finish!: () => void;
    const work = {
      abort,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      run: undefined as string | undefined,
    };
    this.active.set(session, work);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.options.timeoutMs)]);
    try {
      emit({ type: 'status', text: 'running' });
      if (this.name === 'openclaw') {
        const response = await boundedJson(
          await this.fetcher(new URL('/v1/responses', this.options.endpoint), {
            method: 'POST',
            headers: { ...headers, 'x-openclaw-session-key': session },
            body: JSON.stringify({ model: 'openclaw', input: text }),
            signal,
          }),
        );
        const output = (response.output ?? [])
          .flatMap((o: any) => (o.type === 'message' ? (o.content ?? []) : []))
          .filter((c: any) => c.type === 'output_text')
          .map((c: any) => c.text)
          .join('');
        if (response.status !== 'completed' || !output) throw Error('runner_turn_incomplete');
        emit({ type: 'text', text: output });
        return output;
      }
      const admitted = await boundedJson(
        await this.fetcher(new URL('/v1/runs', this.options.endpoint), {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ input: text, session_id: session }),
          signal,
        }),
      );
      if (typeof admitted.run_id !== 'string') throw Error('runner_admission_missing');
      work.run = admitted.run_id;
      for (;;) {
        signal.throwIfAborted();
        const run = await boundedJson(
          await this.fetcher(
            new URL('/v1/runs/' + encodeURIComponent(admitted.run_id), this.options.endpoint),
            { headers, signal },
          ),
        );
        if (run.session_id && run.session_id !== session) throw Error('runner_session_mismatch');
        if (run.status === 'completed') {
          if (typeof run.output !== 'string') throw Error('runner_result_missing');
          emit({ type: 'text', text: run.output });
          return run.output;
        }
        if (['failed', 'cancelled', 'interrupted', 'unknown'].includes(run.status))
          throw Error('runner_' + run.status);
        await delay(250, undefined, { signal });
      }
    } finally {
      this.active.delete(session);
      finish();
    }
  }
  async interrupt(session: string) {
    const work = this.active.get(session);
    if (!work) return;
    // Aborting OpenResponses stops our wait, not a proof of server-side rollback.
    // Hermes provides an explicit per-run cancellation endpoint.
    try {
      if (this.name === 'hermes' && work.run)
        await boundedJson(
          await this.fetcher(
            new URL('/v1/runs/' + encodeURIComponent(work.run) + '/stop', this.options.endpoint),
            {
              method: 'POST',
              headers: this.headers(),
              body: '{}',
              signal: AbortSignal.timeout(5000),
            },
          ),
        );
    } finally {
      work.abort.abort(Error('harness_outcome_unknown'));
      await work.done;
    }
  }
  async close() {
    const running = [...this.active.values()];
    for (const work of running) work.abort.abort(Error('harness_outcome_unknown'));
    await Promise.allSettled(running.map((work) => work.done));
  }
}
