import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { HttpError } from './protocol.js';
/** User-host request receipts and native session references; no display queue. */
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS sessions(device_id TEXT PRIMARY KEY,adapter TEXT NOT NULL,native_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS voice_steers(device_id TEXT NOT NULL,request_id TEXT NOT NULL,run_id TEXT NOT NULL,session_id TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(device_id,request_id));
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,request_id TEXT NOT NULL,status TEXT NOT NULL,text TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,session_request TEXT NOT NULL DEFAULT 'default',resolved_session TEXT,UNIQUE(device_id,request_id));
 UPDATE voice_steers SET status='uncertain' WHERE status='sending';UPDATE runs SET status='uncertain',result='Hub restarted; inspect harness session before retrying' WHERE status='running';`);
  }
  close() {
    this.db.close();
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
    this.db.prepare('UPDATE runs SET status=?,result=? WHERE id=?').run(status, result, id);
  }
}
