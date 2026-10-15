import { TransportFailure } from './transport-failure.js';
export type DispatchRecovery = { wait: (deadline: number) => Promise<void>; windowMs?: number };
const transient = new Set([
  'rpc_outcome_unknown',
  'rpc_queue_timeout',
  'rpc_backpressure',
  'device_not_ready',
  'device_offline',
  'device_disconnected',
  'device_disconnected_before_dispatch',
  'connector_offline',
  'connector_outcome_unknown',
]);
/** Re-read only side-effect-free preparation; a mutation may only wait/retry
 * while the transport explicitly proves its bytes have not been dispatched. */
export async function recoverDispatch<T>(
  work: () => Promise<T>,
  recovery: DispatchRecovery | undefined,
  readOnly: boolean,
): Promise<T> {
  let deadline: number | undefined, lastError: TransportFailure | undefined;
  for (;;) {
    if (deadline !== undefined && Date.now() >= deadline && lastError) {
      lastError.recoveryExhausted = true;
      throw lastError;
    }
    try {
      return await work();
    } catch (error) {
      if (
        !recovery ||
        !(error instanceof TransportFailure) ||
        error.recoveryExhausted ||
        !transient.has(error.message) ||
        (!readOnly && error.dispatched)
      )
        throw error;
      lastError = error;
      deadline ??= Date.now() + (recovery.windowMs ?? 5000);
      if (Date.now() >= deadline) {
        error.recoveryExhausted = true;
        throw error;
      }
      try {
        await recovery.wait(deadline);
      } catch (waitError) {
        if (waitError instanceof TransportFailure) waitError.recoveryExhausted = true;
        throw waitError;
      }
    }
  }
}
export const dispatchPause = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
