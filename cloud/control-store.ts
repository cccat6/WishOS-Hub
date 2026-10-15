import {
  controlReceipt,
  type ControlReceiptStore,
  type ControlRecord,
  type ControlReply,
} from '../src/control-receipts';
export class CloudControlStore implements ControlReceiptStore {
  private cache = new Map<string, ControlReply>();
  constructor(private sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS control_receipts(key TEXT PRIMARY KEY,value TEXT,created INTEGER);UPDATE control_receipts SET value=json_set(value,'$.state','unknown') WHERE json_extract(value,'$.state')='inflight';",
    );
  }
  async read(key: string) {
    const row = this.sql
      .exec<{ value: string }>('SELECT value FROM control_receipts WHERE key=?', key)
      .toArray()[0];
    if (!row) return;
    const value = JSON.parse(row.value) as ControlRecord;
    return { ...value, ...(this.cache.has(key) ? { response: this.cache.get(key) } : {}) };
  }
  async claim(record: ControlRecord) {
    this.sql.exec(
      "DELETE FROM control_receipts WHERE created<? AND json_extract(value,'$.state')='returned'",
      Date.now() - 86400000,
    );
    const prior = await this.read(record.key);
    if (prior) return prior;
    if (this.sql.exec<{ n: number }>('SELECT count(*) n FROM control_receipts').one().n >= 4096)
      throw Error('receipt_capacity_reconcile_first');
    this.sql.exec(
      'INSERT OR IGNORE INTO control_receipts VALUES(?,?,?)',
      record.key,
      JSON.stringify(record),
      record.created,
    );
    return (await this.read(record.key))!;
  }
  async finish(key: string, state: 'returned' | 'unknown', response?: ControlReply) {
    const record = await this.read(key);
    if (!record) throw Error('receipt_missing');
    record.state = state;
    delete record.response;
    if (response) {
      record.receipt = controlReceipt(response);
      this.cache.set(key, response);
      while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    }
    this.sql.exec('UPDATE control_receipts SET value=? WHERE key=?', JSON.stringify(record), key);
  }
}
