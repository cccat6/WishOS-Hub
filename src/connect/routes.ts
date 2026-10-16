import { TransportFailure } from '../transport-failure.js';
import type { DeviceRpc } from '../os-remote.js';
export type RouteName = 'lan' | 'relay';
type Route = {
  rpc: DeviceRpc;
  boot: string;
  priority: number;
  generation: number;
  close?: () => void;
  diagnostics?: () => unknown;
};
/** Pick a route per operation. Never re-run a request whose write may have reached
 * a device; operation receipts, rather than another transport, reconcile it. */
export class DeviceRoutes {
  private routes = new Map<RouteName, Route>();
  private generation = 0;
  private pending = 0;
  get busy() {
    return this.pending > 0;
  }
  constructor(readonly id: string) {}
  attach(
    name: RouteName,
    rpc: DeviceRpc,
    boot: string,
    close?: () => void,
    diagnostics?: () => unknown,
  ) {
    for (const [key, route] of this.routes)
      if (route.boot !== boot) {
        this.routes.delete(key);
        route.close?.();
      }
    const prior = this.routes.get(name),
      generation = ++this.generation;
    this.routes.set(name, {
      rpc,
      boot,
      priority: name === 'lan' ? 0 : 1,
      generation,
      close,
      diagnostics,
    });
    prior?.close?.();
    return () => {
      if (this.routes.get(name)?.generation === generation) this.routes.delete(name);
    };
  }
  private selected() {
    return [...this.routes.entries()].sort((a, b) => a[1].priority - b[1].priority)[0];
  }
  readonly rpc: DeviceRpc = async (path, method, args) => {
    const entry = this.selected();
    if (!entry) throw new TransportFailure('device_disconnected', false);
    const [name, route] = entry;
    ++this.pending;
    try {
      const response = await route.rpc(path, method, args);
      if (response.boot_id !== route.boot) throw Error('device_boot_changed');
      return response;
    } catch (error) {
      const localRefusal =
        error instanceof TransportFailure &&
        !error.dispatched &&
        ['rpc_backpressure', 'rpc_queue_timeout', 'rpc_message_limit'].includes(error.message);
      if (!localRefusal && this.routes.get(name)?.generation === route.generation) {
        this.routes.delete(name);
        route.close?.();
      }
      throw error;
    } finally {
      --this.pending;
    }
  };
  status() {
    const selected = this.selected();
    return {
      online: Boolean(selected),
      route: selected?.[0],
      boot_id: selected?.[1].boot,
      available_routes: [...this.routes.keys()],
      failover: 'next_operation_no_mutation_replay',
      ...(selected?.[1].diagnostics ? { diagnostics: selected[1].diagnostics() } : {}),
    };
  }
  close() {
    for (const r of this.routes.values()) r.close?.();
    this.routes.clear();
  }
}
