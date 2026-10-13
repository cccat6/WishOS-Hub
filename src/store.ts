import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { CommandRequest, type CommandPayload, HttpError, terminal } from './protocol.js';

export interface Command {
  id: string;
  device_id: string;
  request_id: string;
  revision: number;
  op: string;
  payload: CommandPayload;
  status: string;
  created_at: number;
  expires_at: number;
  detail: string | null;
}
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, device_id TEXT NOT NULL, request_id TEXT NOT NULL,
      revision INTEGER NOT NULL, op TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, detail TEXT, UNIQUE(device_id,request_id));
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT '{}', last_seen INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(device_id TEXT PRIMARY KEY, adapter TEXT NOT NULL, native_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_steers(device_id TEXT NOT NULL, request_id TEXT NOT NULL,
        run_id TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY(device_id,request_id));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, device_id TEXT NOT NULL, request_id TEXT NOT NULL,
        status TEXT NOT NULL, text TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, UNIQUE(device_id, request_id));`);
    const runColumns = this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
    if (!runColumns.some((column) => column.name === 'session_request'))
      this.db.exec("ALTER TABLE runs ADD COLUMN session_request TEXT NOT NULL DEFAULT 'default'");
    // A crash is not permission to replay a possibly side-effecting operation.
    this.db.exec(
      "UPDATE voice_steers SET status='uncertain' WHERE status='sending'; UPDATE commands SET status='uncertain', detail='hub restarted during execution' WHERE status IN ('sent','accepted','running'); UPDATE runs SET status='uncertain', result='Hub restarted; inspect harness session before retrying' WHERE status='running';",
    );
  }
  close() {
    this.db.close();
  }
  command(id: string): Command | undefined {
    const r = this.db.prepare('SELECT * FROM commands WHERE id=?').get(id) as any;
    return r ? { ...r, payload: JSON.parse(r.payload) } : undefined;
  }
  enqueue(device: string, raw: unknown, now = Date.now()): Command {
    const input = CommandRequest.parse(raw);
    const payload: any = { ...input.payload };
    if (!payload.content_hash) {
      const value =
        payload.op === 'display_rle'
          ? Buffer.from(payload.data, 'base64')
          : payload.op === 'display'
            ? Buffer.from(JSON.stringify(payload.scene), 'utf8')
            : null;
      if (value) payload.content_hash = createHash('sha256').update(value).digest('hex');
    }
    (input as any).payload = payload;
    const old = this.db
      .prepare('SELECT id FROM commands WHERE device_id=? AND request_id=?')
      .get(device, input.request_id) as any;
    if (old) {
      const c = this.command(old.id)!;
      if (JSON.stringify(c.payload) !== JSON.stringify(input.payload))
        throw new HttpError(409, 'request_id reused with different payload');
      return c;
    }
    const count = this.db
      .prepare(
        "SELECT count(*) AS n FROM commands WHERE device_id=? AND status IN ('queued','sent','accepted','running')",
      )
      .get(device) as any;
    if (count.n >= 32) throw new HttpError(429, 'device command queue full');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { n } = this.db
        .prepare('SELECT coalesce(max(revision),0)+1 AS n FROM commands WHERE device_id=?')
        .get(device) as any;
      if (input.payload.op === 'shutdown')
        this.db
          .prepare(
            "UPDATE commands SET status='superseded' WHERE device_id=? AND op IN ('display','builtin','display_rle','maintenance') AND status='queued'",
          )
          .run(device);
      if (
        input.payload.op === 'display' ||
        input.payload.op === 'builtin' ||
        input.payload.op === 'display_rle'
      )
        this.db
          .prepare(
            "UPDATE commands SET status='superseded' WHERE device_id=? AND op IN ('display','builtin','display_rle') AND status='queued' AND coalesce(json_extract(payload,'$.voice_feedback'),0)=0",
          )
          .run(device);
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO commands VALUES(?,?,?,?,?,?,?,?,?,NULL)')
        .run(
          id,
          device,
          input.request_id,
          n,
          input.payload.op,
          JSON.stringify(input.payload),
          'queued',
          now,
          now + input.ttl_s * 1000,
        );
      this.db.exec('COMMIT');
      return this.command(id)!;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  next(device: string, now = Date.now()): Command | undefined {
    this.expire(now);
    const active = this.db
      .prepare(
        "SELECT op FROM commands WHERE device_id=? AND status IN ('sent','accepted','running')",
      )
      .all(device) as { op: string }[];
    if (active.length) {
      // White-before-off can interrupt a waiting display; a second shutdown cannot overtake it.
      if (
        active.every((c) => ['display', 'builtin', 'display_rle', 'maintenance'].includes(c.op))
      ) {
        const urgent = this.db
          .prepare(
            "SELECT id FROM commands WHERE device_id=? AND op='shutdown' AND status='queued' ORDER BY CASE WHEN op='shutdown' THEN 0 ELSE 1 END,revision LIMIT 1",
          )
          .get(device) as any;
        return urgent ? this.command(urgent.id) : undefined;
      }
      return;
    }
    const r = this.db
      .prepare(
        "SELECT id FROM commands WHERE device_id=? AND status='queued' ORDER BY CASE WHEN op='shutdown' THEN 0 ELSE 1 END,revision LIMIT 1",
      )
      .get(device) as any;
    return r ? this.command(r.id) : undefined;
  }
  markSent(id: string) {
    this.db.prepare("UPDATE commands SET status='sent' WHERE id=? AND status='queued'").run(id);
  }
  ack(device: string, id: string, status: string, detail = '') {
    const c = this.command(id);
    if (!c || c.device_id !== device || terminal.has(c.status) || c.status === 'queued')
      return false;
    const rank: Record<string, number> = {
      sent: 0,
      accepted: 1,
      running: 2,
      completed: 3,
      failed: 3,
      rejected: 3,
    };
    if (rank[status] === undefined || rank[status]! < rank[c.status]!) return false;
    this.db.prepare('UPDATE commands SET status=?,detail=? WHERE id=?').run(status, detail, id);
    return true;
  }
  reconcile(device: string, id: string, status: string, detail: string) {
    const c = this.command(id);
    if (
      c?.device_id === device &&
      c.status === 'uncertain' &&
      ['completed', 'failed', 'rejected'].includes(status)
    ) {
      this.db
        .prepare("UPDATE commands SET status=?,detail=? WHERE id=? AND status='uncertain'")
        .run(status, detail, id);
      return true;
    }
    return this.ack(device, id, status, detail);
  }
  disconnected(device: string) {
    // Replaying a sleep after reconnection could unexpectedly switch the device off again.
    this.db
      .prepare(
        "UPDATE commands SET status='uncertain',detail='connection lost before final receipt' WHERE device_id=? AND status IN ('sent','accepted','running')",
      )
      .run(device);
  }
  expire(now = Date.now()) {
    this.db
      .prepare("UPDATE commands SET status='expired' WHERE status='queued' AND expires_at<=?")
      .run(now);
    this.db
      .prepare(
        "UPDATE commands SET status='uncertain',detail='deadline passed after dispatch' WHERE status IN ('sent','accepted','running') AND expires_at<=?",
      )
      .run(now);
  }
  report(device: string, state: unknown) {
    this.db
      .prepare(
        'INSERT INTO devices VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,last_seen=excluded.last_seen',
      )
      .run(device, JSON.stringify(state), Date.now());
  }
  state(device: string) {
    const r = this.db.prepare('SELECT state,last_seen FROM devices WHERE id=?').get(device) as any;
    return r
      ? { state: JSON.parse(r.state), last_seen: r.last_seen }
      : { state: null, last_seen: null };
  }
  session(device: string, adapter: string): string | undefined {
    return (
      this.db
        .prepare('SELECT native_id FROM sessions WHERE device_id=? AND adapter=?')
        .get(device, adapter) as any
    )?.native_id;
  }
  bind(device: string, adapter: string, id: string) {
    this.db
      .prepare(
        'INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET adapter=excluded.adapter,native_id=excluded.native_id',
      )
      .run(device, adapter, id);
  }
  createRun(device: string, request: string, text: string, sessionRequest = 'default') {
    const old = this.db
      .prepare('SELECT * FROM runs WHERE device_id=? AND request_id=?')
      .get(device, request) as any;
    if (old) {
      if (old.text !== text || old.session_request !== sessionRequest)
        throw new HttpError(409, 'request_id reused');
      return { run: old, fresh: false };
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO runs (id,device_id,request_id,status,text,result,created_at,session_request) VALUES(?,?,?,'running',?,NULL,?,?)",
      )
      .run(id, device, request, text, Date.now(), sessionRequest);
    return { run: this.run(id), fresh: true };
  }
  run(id: string): any {
    return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
  }
  finishRun(id: string, status: string, result: string) {
    this.db
      .prepare('UPDATE runs SET status=?,result=? WHERE id=?')
      .run(status, result.slice(0, 64000), id);
  }
}
