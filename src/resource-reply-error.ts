import type { DeviceRpc } from './os-remote.js';
/** A returned resource refusal is evidence, not a transport timeout inferred
 * from its error spelling. Preserve not_dispatched for the requested operation. */
export class ResourceReplyError extends Error {
  constructor(readonly reply: Awaited<ReturnType<DeviceRpc>>) {
    super(reply.error ?? 'device_operation_failed');
    this.name = 'ResourceReplyError';
  }
}
