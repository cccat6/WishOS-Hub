import { createHash } from 'node:crypto';
import { canonicalValue } from './control-receipts.js';
import type { RemoteRequest } from './os-remote.js';
export function managedContext(request: RemoteRequest) {
  const input = request.payload.input as Record<string, unknown>;
  const { text: _, recording_id: __, ...application } = input;
  return {
    ...(request.payload.context !== undefined ? { system: request.payload.context } : {}),
    application,
  };
}
export function managedRequestScope(request: RemoteRequest): string | undefined {
  if (request.payload.context === undefined) return undefined; // Legacy request contract.
  const current = (request.payload.context as any)?.current;
  if (!Number.isSafeInteger(current?.instance_id) || current.instance_id <= 0)
    return 'system:' + request.request_id;
  return createHash('sha256')
    .update(
      canonicalValue([request.boot_id ?? '', current.application_id ?? '', current.instance_id]),
    )
    .digest('hex');
}
