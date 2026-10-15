import type { DatabaseSync } from 'node:sqlite';
import type { ControlReceiptStore, ControlRecord, ControlReply } from '../control-receipts.js';
import { controlReceipt } from '../control-receipts.js';
export class HostControlStore implements ControlReceiptStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS control_receipts(key TEXT PRIMARY KEY,value TEXT,created INTEGER);UPDATE control_receipts SET value=json_set(value,'$.state','unknown') WHERE json_extract(value,'$.state')='inflight';",
    );
  }
  list() {
    return this.db
      .prepare(
        "SELECT value FROM control_receipts WHERE json_extract(value,'$.state') IN ('inflight','unknown') ORDER BY created DESC LIMIT 100",
      )
      .all()
      .map((row) => {
        const { response, fingerprint, attempt, ...record } = JSON.parse(
          (row as any).value,
        ) as ControlRecord;
        return record;
      });
  }
  async reconcile(key: string, resolution: 'completed' | 'not_completed') {
    const record = await this.read(key);
    if (!record || record.state !== 'unknown') throw Error('receipt_not_uncertain');
    record.state = 'reconciled';
    record.resolution = resolution;
    delete record.response;
    this.db
      .prepare('UPDATE control_receipts SET value=? WHERE key=?')
      .run(JSON.stringify(record), key);
    return { reconciled: true, replayed: false };
  }
  async read(key: string) {
    const row = this.db.prepare('SELECT value FROM control_receipts WHERE key=?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as ControlRecord) : undefined;
  }
  async claim(record: ControlRecord) {
    this.db
      .prepare(
        "DELETE FROM control_receipts WHERE created<? AND json_extract(value,'$.state')='returned'",
      )
      .run(Date.now() - 86400000);
    const exists = await this.read(record.key);
    if (exists) return exists;
    if (
      (this.db.prepare('SELECT count(*) n FROM control_receipts').get() as { n: number }).n >= 4096
    )
      throw Error('receipt_capacity_reconcile_first');
    this.db
      .prepare('INSERT OR IGNORE INTO control_receipts VALUES(?,?,?)')
      .run(record.key, JSON.stringify(record), record.created);
    return (await this.read(record.key))!;
  }
  async finish(key: string, state: 'returned' | 'unknown', response?: ControlReply) {
    const record = await this.read(key);
    if (!record) throw Error('receipt_missing');
    record.state = state;
    if (response) {
      record.response = response;
      record.receipt = controlReceipt(response);
    }
    this.db
      .prepare('UPDATE control_receipts SET value=? WHERE key=?')
      .run(JSON.stringify(record), key);
  }
}
