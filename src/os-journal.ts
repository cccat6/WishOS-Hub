import type { DatabaseSync } from 'node:sqlite';
export type JournalEntry = {
  state: 'executing' | 'ready' | 'acknowledged';
  fingerprint: string;
  ok?: boolean;
  result?: unknown;
};
export interface RemoteJournal {
  get(key: string): JournalEntry | undefined;
  begin(key: string, fingerprint: string): void;
  complete(key: string, fingerprint: string, ok: boolean, result: unknown): void;
  acknowledge(key: string): void;
}
export class MemoryRemoteJournal implements RemoteJournal {
  private entries = new Map<string, JournalEntry>();
  get(key: string) {
    return this.entries.get(key);
  }
  begin(key: string, fingerprint: string) {
    this.entries.set(key, { state: 'executing', fingerprint });
  }
  complete(key: string, fingerprint: string, ok: boolean, result: unknown) {
    this.entries.set(key, { state: 'ready', fingerprint, ok, result });
  }
  acknowledge(key: string) {
    const item = this.entries.get(key);
    if (item) item.state = 'acknowledged';
  }
}
/** Host-side delivery journal. A restart never grants permission to repeat an
 * application side effect whose outcome was not durably recorded. */
export class SqlRemoteJournal implements RemoteJournal {
  constructor(
    private db: DatabaseSync,
    private device: string,
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS os_remote_journal(device TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,ok INTEGER,result TEXT,PRIMARY KEY(device,key))',
    );
  }
  get(key: string) {
    const row = this.db
      .prepare('SELECT * FROM os_remote_journal WHERE device=? AND key=?')
      .get(this.device, key) as
      | {
          state: JournalEntry['state'];
          fingerprint: string;
          ok: number | null;
          result: string | null;
        }
      | undefined;
    return row
      ? {
          state: row.state,
          fingerprint: row.fingerprint,
          ok: row.ok === null ? undefined : !!row.ok,
          result: row.result === null ? undefined : JSON.parse(row.result),
        }
      : undefined;
  }
  begin(key: string, fingerprint: string) {
    this.db
      .prepare(
        "INSERT INTO os_remote_journal VALUES(?,?,?,'executing',NULL,NULL) ON CONFLICT(device,key) DO UPDATE SET state='executing'",
      )
      .run(this.device, key, fingerprint);
  }
  complete(key: string, fingerprint: string, ok: boolean, result: unknown) {
    this.db
      .prepare(
        "INSERT INTO os_remote_journal VALUES(?,?,?,'ready',?,?) ON CONFLICT(device,key) DO UPDATE SET state='ready',ok=excluded.ok,result=excluded.result",
      )
      .run(this.device, key, fingerprint, Number(ok), JSON.stringify(result));
  }
  acknowledge(key: string) {
    this.db
      .prepare("UPDATE os_remote_journal SET state='acknowledged' WHERE device=? AND key=?")
      .run(this.device, key);
  }
}
