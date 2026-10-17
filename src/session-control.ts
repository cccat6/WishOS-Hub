import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { HarnessAdapter } from './adapters/types.js';
import type { HarnessSession, HarnessMessage } from './adapters/sessions.js';
import { canonicalValue } from './control-receipts.js';
import { Id } from './protocol.js';

export const SessionId = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !/[\r\n\0]/.test(s));
const runtimeId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const scope = z.string().min(1).max(64);
const common = {
  kind: z.literal('session_control'),
  runtime_id: runtimeId.optional(),
  session_scope: scope.optional(),
};
const paging = {
  cursor: z.string().max(128).nullable().optional(),
  limit: z.number().int().min(1).max(20).default(5),
};
export const SessionControlInput = z.discriminatedUnion('operation', [
  z
    .object({
      ...common,
      operation: z.literal('status'),
      session_id: SessionId.optional(),
      operation_id: Id.optional(),
    })
    .strict(),
  z.object({ ...common, operation: z.literal('list'), ...paging }).strict(),
  z.object({ ...common, operation: z.literal('create'), operation_id: Id }).strict(),
  z.object({ ...common, operation: z.literal('select'), session_id: SessionId }).strict(),
  z
    .object({
      ...common,
      operation: z.literal('messages'),
      session_id: SessionId,
      ...paging,
      text_max_bytes: z.number().int().min(8).max(1024).default(256),
    })
    .strict(),
]);
export type SessionReference = { runtime_id: string; session_id: string; session_scope: string };
export const SessionReferenceSchema = z
  .object({
    runtime_id: runtimeId,
    session_id: SessionId,
    session_scope: scope,
  })
  .strict();
export type SessionBinding = {
  device_id: string;
  runtime_id: string;
  scope: string;
  adapter: HarnessAdapter;
  default_session?: string;
};
export function runtimeSessionScope(config: Record<string, unknown>) {
  const keys = [
    'id',
    'kind',
    'command',
    'args',
    'cwd',
    'endpoint',
    'home',
    'profile',
    'authTokenEnv',
  ];
  const identity = Object.fromEntries(
    keys.filter((k) => config[k] !== undefined).map((k) => [k, config[k]]),
  );
  if (config.kind === 'codex') identity.native_home = process.env.CODEX_HOME ?? null;
  return createHash('sha256').update(canonicalValue(identity)).digest('hex').slice(0, 32);
}
export function validateSessionReference(binding: SessionBinding, input: Record<string, unknown>) {
  if (input.runtime_id !== undefined && input.runtime_id !== binding.runtime_id)
    throw Error('session_runtime_mismatch');
  if (input.session_scope !== undefined && input.session_scope !== binding.scope)
    throw Error('session_scope_changed');
  if (input.session_id !== undefined && input.session_id !== null)
    SessionId.parse(input.session_id);
}
function cut(text: string, maxBytes: number) {
  let out = '',
    bytes = 0;
  for (const cp of text) {
    const n = Buffer.byteLength(cp);
    if (bytes + n > maxBytes) break;
    out += cp;
    bytes += n;
  }
  return out;
}
function title(text: string) {
  let out = '',
    n = 0;
  for (const cp of text) {
    if (n++ === 40) break;
    out += cp;
  }
  return out;
}
function publicText(role: 'user' | 'assistant', text: string) {
  if (role === 'user' && text.startsWith('WishOS 托管请求 ') && text.includes('wishos-result/2')) {
    const at = text.indexOf('\nUser request:\n');
    return at < 0 ? '' : text.slice(at + 15);
  }
  if (role === 'assistant')
    try {
      const v = JSON.parse(text);
      if (v.format === 'wishos-result/2')
        return (v.actions ?? [])
          .filter((a: any) => a.type === 'application' && typeof a.data?.text === 'string')
          .map((a: any) => a.data.text)
          .join('\n');
    } catch {
      /* Ordinary text or a native display excerpt. */
    }
  return text;
}
type Cursor = {
  key: string;
  expires: number;
  native?: string;
  buffer: any[];
  end: boolean;
  bytes?: number;
};
/** Native session metadata and bounded display pages, never canonical chat storage. */
export class SessionControl {
  private cursors = new Map<string, Cursor>();
  private active = new Map<string, Promise<any>>();
  private closed = false;
  constructor(
    private db: DatabaseSync,
    private cursorPolicy = { maximum: 128, ttlMs: 300000, maxBytes: 4 * 1024 * 1024 },
  ) {
    if (!Object.values(cursorPolicy).every((n) => Number.isSafeInteger(n) && n > 0))
      throw Error('session_cursor_policy');
    db.exec(
      'CREATE TABLE IF NOT EXISTS session_operations(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT,updated INTEGER NOT NULL)',
    );
    db.prepare(
      "UPDATE session_operations SET state='uncertain',error='host_restarted' WHERE state='executing'",
    ).run();
  }
  get activeCount() {
    return this.active.size;
  }
  close() {
    this.closed = true;
    for (const key of this.active.keys())
      this.db
        .prepare(
          "UPDATE session_operations SET state='uncertain',error='host_closed' WHERE key=? AND state='executing'",
        )
        .run(key);
    this.cursors.clear();
  }
  operations(a: HarnessAdapter) {
    return [
      'status',
      ...(a.listSessions ? ['list'] : []),
      ...(a.createSession ? ['create'] : []),
      ...(a.readSession ? ['select'] : []),
      ...(a.listMessages ? ['messages'] : []),
    ];
  }
  private ref(b: SessionBinding, id: string): SessionReference {
    return { runtime_id: b.runtime_id, session_id: SessionId.parse(id), session_scope: b.scope };
  }
  private entry(b: SessionBinding, s: HarnessSession, summary = false) {
    const preview = s.summary ? publicText('user', s.summary) : '';
    return {
      reference: this.ref(b, s.id),
      title: title(s.title),
      ...(summary && preview ? { summary: cut(preview, 256) } : {}),
      ...(s.created_at !== undefined ? { created_at: s.created_at } : {}),
      ...(s.updated_at !== undefined ? { updated_at: s.updated_at } : {}),
      ...(s.state ? { state: s.state } : {}),
      ...(s.ephemeral !== undefined ? { ephemeral: s.ephemeral } : {}),
    };
  }
  private cursorKey(b: SessionBinding, operation: string, id?: string) {
    return canonicalValue([b.device_id, b.runtime_id, b.scope, operation, id ?? null]);
  }
  private resume(token: string | undefined | null, key: string): Cursor {
    if (!token) return { key, expires: 0, buffer: [], end: false };
    const value = this.cursors.get(token);
    if (!value || value.expires <= Date.now()) {
      this.cursors.delete(token);
      throw Error('session_cursor_expired');
    }
    if (value.key !== key) throw Error('session_cursor_scope_changed');
    return { ...value, buffer: value.buffer.slice() };
  }
  private save(value: Cursor) {
    if (value.end && !value.buffer.length) return null;
    for (const [k, v] of this.cursors) if (v.expires <= Date.now()) this.cursors.delete(k);
    const bytes = Buffer.byteLength(
      JSON.stringify({
        key: value.key,
        native: value.native,
        buffer: value.buffer,
        end: value.end,
      }),
    );
    if (bytes > this.cursorPolicy.maxBytes) throw Error('session_cursor_buffer_limit');
    let used = [...this.cursors.values()].reduce((n, v) => n + (v.bytes ?? 0), 0);
    while (
      this.cursors.size >= this.cursorPolicy.maximum ||
      used + bytes > this.cursorPolicy.maxBytes
    ) {
      used -= this.cursors.values().next().value!.bytes ?? 0;
      this.cursors.delete(this.cursors.keys().next().value!);
    }
    const token = 'wsc1_' + randomBytes(18).toString('base64url');
    this.cursors.set(token, { ...value, expires: Date.now() + this.cursorPolicy.ttlMs, bytes });
    return token;
  }
  private async create(b: SessionBinding, operationId: string) {
    const key = canonicalValue([b.device_id, operationId]),
      fingerprint = canonicalValue([b.runtime_id, b.scope, 'create']);
    const prior = this.db.prepare('SELECT * FROM session_operations WHERE key=?').get(key) as any;
    if (prior && prior.fingerprint !== fingerprint) throw Error('session_operation_scope_changed');
    const running = this.active.get(key);
    if (running) return running;
    if (prior) {
      if (prior.state === 'completed') return JSON.parse(prior.result);
      throw Error('session_creation_outcome_unknown');
    }
    this.db
      .prepare("INSERT INTO session_operations VALUES(?,?,'executing',NULL,NULL,?)")
      .run(key, fingerprint, Date.now());
    const work = (async () => {
      try {
        const s = await b.adapter.createSession!(),
          result = { selected_session: this.ref(b, s.id), session: this.entry(b, s, true) };
        if (this.closed) throw Error('session_service_closed');
        this.db
          .prepare("UPDATE session_operations SET state='completed',result=?,updated=? WHERE key=?")
          .run(JSON.stringify(result), Date.now(), key);
        return result;
      } catch (e) {
        if (!this.closed)
          this.db
            .prepare(
              "UPDATE session_operations SET state='uncertain',error=?,updated=? WHERE key=?",
            )
            .run(e instanceof Error ? e.message : String(e), Date.now(), key);
        throw Error('session_creation_outcome_unknown');
      }
    })();
    this.active.set(key, work);
    try {
      return await work;
    } finally {
      this.active.delete(key);
    }
  }
  async invoke(
    binding: SessionBinding,
    raw: unknown,
    requestId: string,
    fits: (data: any) => boolean = () => true,
  ): Promise<any> {
    const b = binding;
    const request = raw as any;
    let operation = ['status', 'list', 'create', 'select', 'messages'].includes(request?.operation)
        ? request.operation
        : 'status',
      opId: string | undefined =
        operation === 'create' && Id.safeParse(request?.operation_id).success
          ? request.operation_id
          : undefined;
    const base = () => ({
      format: 'wishos-session-control/1',
      operation,
      ...(requestId ? { request_id: requestId } : {}),
      runtime_id: b.runtime_id,
    });
    try {
      if (this.closed) throw Error('session_service_closed');
      const p = SessionControlInput.parse(raw);
      operation = p.operation;
      validateSessionReference(b, p);
      if (!this.operations(b.adapter).includes(operation))
        throw Error('session_operation_not_supported');
      let result: any = { ...base(), ok: true };
      if (p.operation === 'status') {
        const id = p.session_id ?? b.default_session;
        result = {
          ...result,
          operations: this.operations(b.adapter),
          default_session: b.default_session ? this.ref(b, b.default_session) : null,
          selected_session: id ? this.ref(b, id) : null,
          limits: {
            limit_max: 20,
            cursor_max_bytes: 128,
            text_max_bytes: 1024,
            cursor_ttl_ms: this.cursorPolicy.ttlMs,
          },
        };
        if (id && b.adapter.readSession)
          try {
            result.session = this.entry(b, await b.adapter.readSession(id), true);
          } catch (error) {
            if (p.session_id) throw error;
            result.default_session_error = { code: 'harness_session_unavailable' };
          }
        if (p.operation_id) {
          const receipt = this.db
            .prepare('SELECT state,result,fingerprint FROM session_operations WHERE key=?')
            .get(canonicalValue([b.device_id, p.operation_id])) as any;
          const expected = canonicalValue([b.runtime_id, b.scope, 'create']);
          result.creation = receipt
            ? {
                operation_id: p.operation_id,
                state: receipt.fingerprint === expected ? receipt.state : 'scope_changed',
                ...(receipt.result && receipt.fingerprint === expected
                  ? { selected_session: JSON.parse(receipt.result).selected_session }
                  : {}),
              }
            : { operation_id: p.operation_id, state: 'not_found' };
        }
      } else if (p.operation === 'select') {
        const s = await b.adapter.readSession!(p.session_id);
        if (s.id !== p.session_id) throw Error('session_identity_mismatch');
        result = {
          ...result,
          selected_session: this.ref(b, s.id),
          session: this.entry(b, s, true),
        };
      } else if (p.operation === 'create') {
        opId = p.operation_id;
        result = { ...result, operation_id: opId, ...(await this.create(b, opId)) };
      } else {
        const id = p.operation === 'messages' ? p.session_id : undefined;
        const key = this.cursorKey(b, p.operation, id),
          state = this.resume(p.cursor, key),
          entries: any[] = [];
        for (let attempts = 0; entries.length < p.limit && attempts < p.limit * 2; attempts++) {
          if (!state.buffer.length && !state.end) {
            const page =
              p.operation === 'list'
                ? await b.adapter.listSessions!({ cursor: state.native, limit: p.limit })
                : await b.adapter.listMessages!(p.session_id, {
                    cursor: state.native,
                    limit: p.limit,
                  });
            if (page.next_cursor !== null && page.next_cursor === state.native)
              throw Error('session_cursor_stalled');
            state.native = page.next_cursor ?? undefined;
            state.end = page.next_cursor === null;
            state.buffer =
              p.operation === 'list'
                ? (page.entries as HarnessSession[]).map((s) => this.entry(b, s))
                : (page.entries as HarnessMessage[]).map((m) => {
                    const text = publicText(m.role, m.text),
                      excerpt = cut(text, p.text_max_bytes);
                    return {
                      message_id: m.id,
                      role: m.role,
                      text: excerpt,
                      truncated: excerpt !== text,
                      preview: m.preview === true,
                      ...(m.created_at !== undefined ? { created_at: m.created_at } : {}),
                    };
                  });
          }
          if (!state.buffer.length) {
            if (state.end) break;
            continue;
          }
          // Reserve the full short-token length before consuming this entry.
          const candidate = {
            ...result,
            entries: [...entries, state.buffer[0]],
            next_cursor: 'wsc1_' + 'x'.repeat(24),
          };
          if (!fits(candidate)) {
            if (!entries.length) throw Error('session_entry_envelope_limit');
            break;
          }
          entries.push(state.buffer.shift());
        }
        result = { ...result, entries, next_cursor: this.save(state) };
      }
      if (!fits(result) && result.session?.summary) {
        result.session = { ...result.session };
        delete result.session.summary;
      }
      if (!fits(result) && result.session) delete result.session;
      if (!fits(result)) throw Error('session_result_envelope_limit');
      return result;
    } catch (e) {
      return {
        ...base(),
        ok: false,
        ...(opId ? { operation_id: opId } : {}),
        error: {
          code:
            e instanceof z.ZodError
              ? 'session_control_input'
              : e instanceof Error &&
                  /^(session|harness_session|harness_message)_[a-z_]+$/.test(e.message)
                ? e.message
                : 'harness_session_unavailable',
        },
      };
    }
  }
}
