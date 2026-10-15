export type ResourceJob = {
  id: string;
  fingerprint: string;
  kind: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'unknown';
  diagnostics?: unknown[];
  receipts?: Record<string, unknown>;
  created: number;
  updated: number;
  result?: unknown;
  error?: string;
};
export interface ResourceJobStore {
  read(id: string): ResourceJob | undefined;
  save(job: ResourceJob): void;
  list(): ResourceJob[];
}
/** A control request returns an operation identity before potentially long work.
 * Only its owner invokes effects; reconnects read the original receipt. */
export class ResourceJobs {
  private active = new Map<string, { abort: AbortController; work: Promise<void> }>();
  private closing = false;
  constructor(
    private store: ResourceJobStore,
    private limits = { concurrency: 2, timeoutMs: 300000 },
  ) {}
  read(id: string) {
    const value = this.store.read(id);
    if (!value) throw Error('resource_job_not_found');
    return value;
  }
  list() {
    return this.store.list();
  }
  wait(id: string) {
    return this.active.get(id)?.work ?? Promise.resolve();
  }
  submit(
    id: string,
    fingerprint: string,
    kind: string,
    execute: (signal: AbortSignal) => Promise<unknown>,
  ) {
    if (this.closing) throw Error('resource_service_closing');
    const prior = this.store.read(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw Error('resource_job_identity_conflict');
      return prior;
    }
    if (this.active.size >= this.limits.concurrency) throw Error('resource_service_busy');
    const job: ResourceJob = {
      id,
      fingerprint,
      kind,
      state: 'running',
      created: Date.now(),
      updated: Date.now(),
    };
    this.store.save(job);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.limits.timeoutMs)]);
    const work = Promise.resolve()
      .then(() => execute(signal))
      .then(
        (result) => {
          job.state = 'completed';
          job.result = result;
        },
        (error) => {
          // A cancelled delivery might already have committed. Preserve uncertainty.
          job.state =
            kind === 'deliver' && !(error instanceof Error && error.name === 'PreflightError')
              ? 'unknown'
              : 'failed';
          job.error = error instanceof Error ? error.message : 'resource_job_failed';
          if (error?.diagnostics) job.diagnostics = error.diagnostics;
          if (error?.receipts) job.receipts = error.receipts;
          if (error instanceof Error && error.name === 'PackageOutcomeUnknown')
            job.state = 'unknown';
        },
      )
      .then(() => {
        job.updated = Date.now();
        this.store.save(job);
      })
      .finally(() => this.active.delete(id));
    this.active.set(id, { abort, work });
    return { ...job };
  }
  cancel(id: string) {
    const job = this.read(id);
    this.active.get(id)?.abort.abort(Error('resource_job_cancelled'));
    return { job_id: id, cancellation_requested: job.state === 'running', rollback: false };
  }
  async close() {
    this.closing = true;
    const entries = [...this.active.values()];
    for (const e of entries) e.abort.abort(Error('resource_service_shutdown'));
    await Promise.allSettled(entries.map((e) => e.work));
  }
}
