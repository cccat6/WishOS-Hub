import type { DatabaseSync } from 'node:sqlite';
import type { ResourceJob, ResourceJobStore } from '../resource-jobs.js';
export class HostJobStore implements ResourceJobStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS resource_jobs(id TEXT PRIMARY KEY, value TEXT,updated INTEGER);UPDATE resource_jobs SET value=json_set(value,'$.state','unknown','$.error','connector_restarted') WHERE json_extract(value,'$.state') IN ('queued','running');",
    );
  }
  read(id: string) {
    const r = this.db.prepare('SELECT value FROM resource_jobs WHERE id=?').get(id) as
      | { value: string }
      | undefined;
    return r ? (JSON.parse(r.value) as ResourceJob) : undefined;
  }
  save(job: ResourceJob) {
    this.db
      .prepare(
        "DELETE FROM resource_jobs WHERE updated<? AND json_extract(value,'$.state') IN ('completed','failed')",
      )
      .run(Date.now() - 86400000);
    if (
      !this.read(job.id) &&
      (this.db.prepare('SELECT count(*) n FROM resource_jobs').get() as any).n >= 4096
    )
      throw Error('resource_job_capacity');
    this.db
      .prepare('INSERT OR REPLACE INTO resource_jobs VALUES(?,?,?)')
      .run(job.id, JSON.stringify(job), job.updated);
  }
  list() {
    return this.db
      .prepare('SELECT value FROM resource_jobs ORDER BY updated DESC LIMIT 100')
      .all()
      .map((r) => JSON.parse((r as any).value) as ResourceJob);
  }
}
