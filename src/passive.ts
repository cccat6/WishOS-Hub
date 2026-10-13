import { type Command, Store } from './store.js';
import { rasterFormat } from './raster.js';
class DeviceHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface PassiveDevice {
  id: string;
  url: string;
  token: string;
}
interface Snapshot {
  online: boolean;
  boot_id: string | null;
  capabilities: Record<string, unknown> | null;
}
export class PassiveDevices {
  private busy = new Set<string>();
  private pollAt = new Map<string, number>();
  private pending = new Map<string, Command>();
  private snapshots = new Map<string, Snapshot>();
  private tasks = new Set<Promise<void>>();
  private controller = new AbortController();
  constructor(
    private devices: PassiveDevice[],
    private store: Store,
  ) {}
  state(id: string): Snapshot {
    return this.snapshots.get(id) ?? { online: false, boot_id: null, capabilities: null };
  }
  tick() {
    for (const device of this.devices) {
      if (this.busy.has(device.id) || this.controller.signal.aborted) continue;
      if (
        !this.pending.has(device.id) &&
        !this.store.next(device.id) &&
        Date.now() - (this.pollAt.get(device.id) ?? 0) < 5000
      )
        continue;
      this.busy.add(device.id);
      const work = this.step(device)
        .catch(() => {
          this.snapshots.set(device.id, { ...this.state(device.id), online: false });
        })
        .finally(() => {
          this.busy.delete(device.id);
          this.tasks.delete(work);
        });
      this.tasks.add(work);
    }
  }
  private async request(d: PassiveDevice, path: string, body?: unknown, timeout = 5000) {
    const response = await fetch(new URL(path, d.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeout)]),
    });
    const result = await response.json();
    if (!response.ok)
      throw new DeviceHttpError(
        response.status,
        `device HTTP ${response.status}: ${JSON.stringify(result)}`,
      );
    return result as any;
  }
  private async step(d: PassiveDevice) {
    const status = await this.request(d, '/api/status');
    if (status.device?.device_id !== d.id || !status.device?.state)
      throw Error('passive device identity mismatch');
    const info = await this.request(d, '/api/info');
    const state = status.device.state;
    const capabilities = {
      display: !!state.display?.hardware_enabled,
      audio: false,
      sleep: !info.research,
      max_scene_bytes: 8192,
      formats: ['scene-v1', 'nmr1', 'nmp1'],
      max_rle_bytes: 6000,
      max_raster_bytes: 8000,
      streaming_images: true,
      max_stream_bytes: 180000,
      refresh_profiles: ['factory', 'fast'],
      builtin_layouts: ['portrait', 'landscape'],
    };
    this.snapshots.set(d.id, {
      online: true,
      boot_id: status.device.boot_id ?? null,
      capabilities,
    });
    this.store.report(d.id, state);
    this.pollAt.set(d.id, Date.now());
    const pending = this.pending.get(d.id);
    if (pending) {
      if (Date.now() > pending.expires_at) {
        this.pending.delete(d.id);
        return;
      }
      let receipt: any;
      try {
        receipt = await this.request(d, '/v2/receipt?id=' + encodeURIComponent(pending.id));
      } catch (error) {
        if (error instanceof DeviceHttpError && error.status === 404) return;
        throw error;
      }
      if (receipt.command_id !== pending.id) throw Error('receipt identity mismatch');
      const stages: Record<string, string> = {
        receiving: 'accepted',
        queued: 'accepted',
        accepted: 'accepted',
        running: 'running',
        completed: 'completed',
        failed: 'failed',
        rejected: 'rejected',
      };
      if (stages[receipt.status])
        this.store.reconcile(
          d.id,
          pending.id,
          stages[receipt.status]!,
          receipt.detail ?? 'device receipt',
        );
      if (
        ['completed', 'failed', 'rejected'].includes(receipt.status) ||
        Date.now() > pending.expires_at
      )
        this.pending.delete(d.id);
      return;
    }
    const c = this.store.next(d.id);
    if (!c) return;
    if (
      (['display', 'builtin', 'display_rle', 'maintenance'].includes(c.op) &&
        !capabilities.display) ||
      (c.op === 'sleep' && !capabilities.sleep)
    ) {
      this.store.markSent(c.id);
      this.store.ack(d.id, c.id, 'rejected', 'device capability unavailable');
      return;
    }
    this.store.markSent(c.id);
    this.pending.set(d.id, c);
    try {
      if (c.payload.op === 'display_rle' && rasterFormat(c.payload.data) === 'nmp1') {
        const data = Buffer.from(c.payload.data, 'base64');
        const form = new FormData();
        form.append(
          'meta',
          JSON.stringify({
            command_id: c.id,
            length: data.length,
            crc: data.readUInt32LE(8),
            token: d.token,
            ttl_ms: Math.max(5000, c.expires_at - Date.now()),
            ...(c.payload.refresh_profile ? { refresh_profile: c.payload.refresh_profile } : {}),
          }),
        );
        form.append('image', new Blob([Uint8Array.from(data)]), 'frame.nmp');
        await this.request(d, '/v2/display', form, 20000);
      } else
        await this.request(d, '/v2/commands', {
          command_id: c.id,
          ttl_ms: Math.max(1, c.expires_at - Date.now()),
          token: d.token,
          payload: c.payload,
        });
      this.store.ack(d.id, c.id, 'accepted', 'device accepted; awaiting receipt');
    } catch (error) {
      if (error instanceof DeviceHttpError && error.status >= 400 && error.status < 500) {
        this.store.ack(d.id, c.id, 'rejected', error.message);
        this.pending.delete(d.id);
        return;
      }
      this.store.db
        .prepare(
          "UPDATE commands SET status='uncertain',detail='HTTP response lost; querying device receipt, never automatically resubmitting' WHERE id=? AND status='sent'",
        )
        .run(c.id);
    }
  }
  async close() {
    this.controller.abort();
    await Promise.allSettled(this.tasks);
  }
}
