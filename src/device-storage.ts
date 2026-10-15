import { ResourceReplyError } from './resource-reply-error.js';
import type { DeviceRpc } from './os-remote.js';
/** Read-only catalog enumeration. Media preparation remains an explicit action. */
export async function readMounts(rpc: DeviceRpc, signal: AbortSignal) {
  const providers: any[] = [];
  let cursor = 0,
    boot: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const reply = await rpc('/fs', 'mounts', {
      // New devices default to four rows; older mounts rejects all page args.
      ...(cursor ? { cursor, limit: 4 } : {}),
      ...(boot ? { expected_boot_id: boot } : {}),
    });
    if (boot && reply.boot_id !== boot) throw Error('device_boot_changed');
    boot = reply.boot_id;
    if (!reply.ok) throw new ResourceReplyError(reply);
    if (!Array.isArray(reply.result.providers)) throw Error('storage_catalog_format');
    providers.push(...reply.result.providers);
    if (!reply.result.more) return providers;
    const next = reply.result.next_cursor;
    if (!Number.isInteger(next) || next <= cursor || next > 0xffffffff)
      throw Error('storage_catalog_cursor');
    cursor = next;
  }
}
