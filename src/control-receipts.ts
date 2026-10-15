import { TransportFailure } from './transport-failure.js';
export type ControlReply = {
  ok: boolean;
  boot_id: string;
  error?: string;
  result: unknown;
  [key: string]: unknown;
};
export type ControlInput = {
  path: string;
  method: string;
  args: Record<string, unknown>;
  request_id?: string;
  expected_boot_id?: string;
};
export type ControlRecord = {
  key: string;
  fingerprint: string;
  device: string;
  boot: string;
  request: string;
  path: string;
  method: string;
  state: 'inflight' | 'returned' | 'unknown' | 'reconciled';
  created: number;
  attempt: string;
  response?: ControlReply;
  receipt?: Record<string, unknown>;
  resolution?: 'completed' | 'not_completed';
};
export interface ControlReceiptStore {
  claim(record: ControlRecord): Promise<ControlRecord>;
  finish(key: string, state: 'returned' | 'unknown', response?: ControlReply): Promise<void>;
  read(key: string): Promise<ControlRecord | undefined>;
}
export function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalValue).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalValue((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}
async function digest(value: unknown) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalValue(value))),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function controlReceipt(reply: ControlReply) {
  const result = reply.result as Record<string, unknown> | null;
  const receipt: Record<string, unknown> = {
    transport_returned: true,
    resource_ok: reply.ok,
    boot_id: reply.boot_id,
  };
  if (reply.error && /^[a-z0-9_:-]{1,96}$/.test(reply.error)) receipt.error = reply.error;
  if (result && typeof result === 'object')
    for (const key of [
      'id',
      'job_id',
      'operation_id',
      'completion_id',
      'application_id',
      'revision',
      'applied_revision',
      'state',
      'accepted',
      'queued',
    ]) {
      const value = result[key];
      if (
        typeof value === 'boolean' ||
        typeof value === 'number' ||
        (typeof value === 'string' && value.length <= 128)
      )
        receipt[key] = value;
    }
  return receipt;
}
/** Authority is the receipt store, not a response cache. Unknown writes remain
 * blocked; returning a receipt never claims a panel/native operation completed. */
export class ControlGuard {
  private active = new Map<string, { fingerprint: string; work: Promise<ControlReply> }>();
  constructor(private store: ControlReceiptStore) {}
  async read(device: string, boot: string, request: string) {
    const record = await this.store.read(device + ':' + boot + ':' + request);
    if (!record) throw Error('receipt_not_found');
    const { fingerprint: _f, attempt: _a, response: _r, ...publicRecord } = record;
    return publicRecord;
  }
  async invoke(
    device: string,
    input: ControlInput,
    describe: () => Promise<ControlReply>,
    execute: () => Promise<ControlReply>,
  ) {
    const schema = await describe();
    if (!schema.ok) return schema;
    const readMethods =
      (schema.result as { read_methods?: string })?.read_methods?.split(',') ?? [];
    if (readMethods.includes(input.method)) return execute();
    if (!input.request_id || !input.request_id.match(/^[A-Za-z0-9_.:-]{1,128}$/))
      throw Error('request_id_required_for_mutation');
    if (!input.expected_boot_id) throw Error('expected_boot_id_required_for_mutation');
    if (schema.boot_id !== input.expected_boot_id) throw Error('device_boot_changed');
    const key = device + ':' + input.expected_boot_id + ':' + input.request_id;
    const fingerprint = await digest({ path: input.path, method: input.method, args: input.args });
    const existing = this.active.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Error('request_id_conflict');
      return existing.work;
    }
    const work = (async () => {
      const record: ControlRecord = {
        key,
        fingerprint,
        device,
        boot: input.expected_boot_id!,
        request: input.request_id!,
        path: input.path,
        method: input.method,
        state: 'inflight',
        created: Date.now(),
        attempt: crypto.randomUUID(),
      };
      const prior = await this.store.claim(record);
      if (prior.fingerprint !== record.fingerprint) throw Error('request_id_conflict');
      if (prior.state === 'returned' || prior.state === 'reconciled') {
        if (prior.response) return prior.response;
        return {
          ok: false,
          boot_id: prior.boot,
          error:
            prior.state === 'reconciled'
              ? 'receipt_manually_reconciled'
              : 'receipt_requires_reconciliation',
          result: { request_id: prior.request, receipt: prior.receipt, executed_again: false },
        };
      }
      if (prior.state === 'unknown' || prior.attempt !== record.attempt)
        throw Error('mutation_outcome_unknown_reconcile_first');
      try {
        const response = await execute();
        if (response.boot_id !== record.boot) throw Error('device_boot_changed');
        await this.store.finish(key, 'returned', response);
        return response;
      } catch (error) {
        if (error instanceof TransportFailure && !error.dispatched) {
          const response: ControlReply = {
            ok: false,
            boot_id: record.boot,
            error: error.message,
            result: { not_dispatched: true },
          };
          await this.store.finish(key, 'returned', response);
          return response;
        }
        await this.store.finish(key, 'unknown');
        throw error;
      }
    })();
    this.active.set(key, { fingerprint, work });
    try {
      return await work;
    } finally {
      this.active.delete(key);
    }
  }
}
