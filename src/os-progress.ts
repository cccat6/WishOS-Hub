import type { DeviceRpc, RemoteRequest } from './os-remote.js';
export type PublicProgress = {
  stage: 'received' | 'receiving' | 'transcribing' | 'executing' | 'preparing' | 'transferring';
  source?: 'hub' | 'harness';
  text?: string;
};
export function boundedMessage(text: string, bytes = 512) {
  let out = '';
  for (const char of text) {
    if (char === '\0') continue;
    if (Buffer.byteLength(out + char) > bytes) break;
    out += char;
  }
  return out;
}
type Row = {
  sequence: number;
  stage: PublicProgress['stage'];
  source: 'hub' | 'harness';
  text: string;
  sent: number;
  at: number;
  attempted: number;
};
/** Latest-only advisory state. Shared by reconnecting bridges, never an execution receipt. */
export class RemoteProgress {
  private rows = new Map<string, Row>();
  private capability?: {
    boot: string;
    supported: boolean;
    bytes: number;
    interval: number;
    serialized: number;
  };
  reconnect() {
    for (const r of this.rows.values()) {
      r.sent = 0;
      r.at = 0;
    }
  }
  private key(r: RemoteRequest) {
    return `${r.boot_id}:${r.id}:${r.request_id}`;
  }
  update(r: RemoteRequest, p: PublicProgress) {
    if (
      !['received', 'receiving', 'transcribing', 'executing', 'preparing', 'transferring'].includes(
        p.stage,
      )
    )
      return;
    const key = this.key(r),
      old = this.rows.get(key),
      text = boundedMessage(p.text ?? ''),
      source = p.source ?? 'hub';
    const order = [
      'received',
      'receiving',
      'transcribing',
      'executing',
      'preparing',
      'transferring',
    ];
    if (old && order.indexOf(p.stage) < order.indexOf(old.stage)) return;
    if (old?.stage === p.stage && old.text === text && old.source === source) return;
    if (!old && this.rows.size >= 16) this.rows.delete(this.rows.keys().next().value!);
    if (old?.sequence === 0xffffffff) return;
    this.rows.set(key, {
      sequence: (old?.sequence ?? 0) + 1,
      stage: p.stage,
      source,
      text,
      sent: old?.sent ?? 0,
      at: old?.at ?? 0,
      attempted: old?.attempted ?? 0,
    });
  }
  retire(r: RemoteRequest) {
    this.rows.delete(this.key(r));
  }
  async flush(r: RemoteRequest, rpc: DeviceRpc, force = false, active = () => true) {
    const row = this.rows.get(this.key(r));
    if (!row || row.sent === row.sequence) return;
    try {
      if (this.capability?.boot !== r.boot_id) {
        const d = await rpc(
          '/sys/capabilities',
          'describe',
          { path: '/services/remote', expected_boot_id: r.boot_id },
          { priority: 'background' },
        );
        if (d.boot_id !== r.boot_id || !d.ok) return;
        const metadata = d.result.progress;
        this.capability = {
          boot: r.boot_id!,
          supported:
            String(d.result.methods ?? '')
              .split(',')
              .includes('progress') && metadata?.format === 'wishos-progress/1',
          bytes: Math.min(512, metadata?.text_limit_bytes ?? 512),
          interval: Math.max(1000, metadata?.min_interval_ms ?? 1000),
          serialized: metadata?.serialized_limit_bytes ?? 1024,
        };
      }
      const capability = this.capability!;
      if (!capability.supported || !active()) return;
      const wait = capability.interval - (Date.now() - row.at);
      if (wait > 0) {
        if (!force || wait > 1000) return;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      if (!active() || !this.rows.has(this.key(r))) return;
      const progress: Record<string, unknown> = {
        format: 'wishos-progress/1',
        stage: row.stage,
        source: row.source,
      };
      if (row.text) {
        const chars = Array.from(boundedMessage(row.text, capability.bytes));
        while (
          chars.length &&
          Buffer.byteLength(JSON.stringify({ ...progress, text: chars.join('') })) >
            capability.serialized
        )
          chars.pop();
        if (chars.length) progress.text = chars.join('');
      }
      row.at = Date.now();
      row.attempted = row.sequence;
      const reply = await rpc(
        '/services/remote',
        'progress',
        {
          id: r.id,
          request_id: r.request_id,
          expected_boot_id: r.boot_id,
          sequence: row.sequence,
          progress,
        },
        { priority: 'background' },
      );
      if (reply.boot_id === r.boot_id && reply.ok) row.sent = row.attempted;
    } catch {
      /* Advisory delivery never changes result disposition; retry latest on next poll. */
    }
  }
}
