import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
/** User-host storage only. Reference names, never values, enter config exports. */
export class LocalSecrets {
  private values: Record<string, string> = {};
  constructor(private root: string) {}
  async load() {
    try {
      const data = JSON.parse(await readFile(join(this.root, 'service-secrets.json'), 'utf8'));
      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        Object.values(data).some((v) => typeof v !== 'string')
      )
        throw Error('local_secret_store_invalid');
      this.values = data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  get(reference?: string) {
    return reference ? this.values[reference] : undefined;
  }
  async set(reference: string, value: string) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(reference) || value.length > 8192 || /[\r\n]/.test(value))
      throw Error('local_service_token_invalid');
    const next = { ...this.values, [reference]: value };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = join(this.root, 'service-secrets.' + randomUUID() + '.tmp');
    await writeFile(temp, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, join(this.root, 'service-secrets.json'));
    this.values = next;
  }
}
