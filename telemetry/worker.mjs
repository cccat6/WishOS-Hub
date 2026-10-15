const response = (status, data) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function readBounded(request) {
  const reader = request.body?.getReader();
  if (!reader) throw Error('body_required');
  let size = 0,
    parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2048) {
        await reader.cancel();
        throw Error('body_limit');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function validate(data) {
  if (
    !data ||
    data.format !== 'wishos-telemetry/1' ||
    !['registration', 'aggregate'].includes(data.kind) ||
    typeof data.receipt !== 'string' ||
    !/^[a-f0-9]{32}$/.test(data.receipt)
  )
    throw Error('format');
  const allowed =
    data.kind === 'registration'
      ? ['format', 'kind', 'receipt', 'device_id', 'boot_id', 'reset_reason']
      : ['format', 'kind', 'receipt', 'metrics'];
  for (const key of Object.keys(data)) if (!allowed.includes(key)) throw Error('unexpected_field');
  if (data.kind === 'registration') {
    if (
      typeof data.device_id !== 'string' ||
      !/^[A-Za-z0-9:._-]{1,64}$/.test(data.device_id) ||
      typeof data.boot_id !== 'string' ||
      !/^[A-Za-z0-9:._-]{1,32}$/.test(data.boot_id)
    )
      throw Error('identifier');
    if (
      data.reset_reason !== undefined &&
      ![
        'unknown',
        'power_on',
        'software',
        'panic',
        'watchdog',
        'deep_sleep',
        'brownout',
        'external',
      ].includes(data.reset_reason)
    )
      throw Error('reset_reason');
  } else {
    if (!data.metrics || typeof data.metrics !== 'object' || Array.isArray(data.metrics))
      throw Error('metrics');
    for (const [k, v] of Object.entries(data.metrics)) {
      if (
        ![
          'application_calls',
          'ai_requests',
          'uptime_ms',
          'input_actions',
          'active_ms',
          'errors',
        ].includes(k) ||
        !/^\d{1,16}$/.test(String(v)) ||
        !Number.isSafeInteger(Number(v))
      )
        throw Error('metric');
    }
  }
  return data;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET')
      return response(200, { ok: true, service: 'wishos-telemetry' });
    if (url.pathname !== '/v1/ingest' || request.method !== 'POST')
      return response(404, { error: 'not_found' });
    let d;
    try {
      d = validate(await readBounded(request));
    } catch (e) {
      return response(400, { error: e.message });
    }
    const day = new Date().toISOString().slice(0, 10),
      now = Date.now();
    try {
      if (d.kind === 'registration') {
        await env.DB.batch([
          env.DB.prepare(
            'INSERT INTO devices(id,first_seen,last_seen) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen',
          ).bind(d.device_id, day, day),
          env.DB.prepare(
            'INSERT OR IGNORE INTO boots(device,boot,day,reset_reason) VALUES(?,?,?,?)',
          ).bind(d.device_id, d.boot_id, day, d.reset_reason ?? 'not_reported'),
        ]);
      } else {
        const m = d.metrics;
        await env.DB.prepare(
          'INSERT OR IGNORE INTO aggregates(receipt,day,calls,inputs,active_ms,errors,received,ai_calls,uptime_ms) VALUES(?,?,?,?,?,?,?,?,?)',
        )
          .bind(
            d.receipt,
            day,
            Number(m.application_calls ?? 0),
            Number(m.input_actions ?? 0),
            Number(m.active_ms ?? 0),
            Number(m.errors ?? 0),
            now,
            Number(m.ai_requests ?? 0),
            Number(m.uptime_ms ?? 0),
          )
          .run();
      }
      return response(200, { accepted: true, receipt: d.receipt });
    } catch {
      return response(503, { error: 'storage_unavailable' });
    }
  },
  async scheduled(_event, env) {
    const day = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM aggregates WHERE day<?').bind(day),
      env.DB.prepare('DELETE FROM boots WHERE day<?').bind(day),
      env.DB.prepare('DELETE FROM devices WHERE last_seen<?').bind(
        new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10),
      ),
    ]);
  },
};
