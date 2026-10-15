export class CloudError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`wishos:${status}:${message}`);
  }
}
export const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
export async function textBody(request: Request, maximum = 262144) {
  const reader = request.body?.getReader();
  if (!reader) throw new CloudError(400, 'body_required');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new CloudError(413, 'body_limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
export const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function fields(value: unknown, allowed: string[]): asserts value is Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new CloudError(400, 'invalid_fields');
}
export function requireOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new CloudError(403, 'origin_rejected');
}
export function random(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export type Role = 'owner' | 'connector' | 'device' | 'mcp' | 'refresh';
export type Grant = {
  role: Role;
  device?: string;
  client?: string;
  scopes: string[];
  expires: number;
};
export function tokenRoom(token: string) {
  const match = token.match(
    /^([a-f0-9-]{36})\.(owner|connector|device|mcp|refresh)\.[A-Za-z0-9_-]{43}$/,
  );
  return match?.[1];
}
export function bearer(request: Request) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) throw new CloudError(401, 'authorization_required');
  const token = auth.slice(7);
  if (!tokenRoom(token)) throw new CloudError(401, 'invalid_token');
  return token;
}
export function html(content: string, status = 200) {
  return new Response(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>WishOS</title><style>body{font:16px system-ui;background:#f8f7f4;color:#252525;max-width:640px;margin:8vh auto;padding:24px}h1{font-size:28px}label{display:block;margin:16px 0}input,button{font:inherit;border:1px solid #ccc;border-radius:9px;padding:12px;box-sizing:border-box}input{width:100%}button{background:#e78146;color:white;border:0;cursor:pointer}small{color:#666;display:block;line-height:1.6}code{overflow-wrap:anywhere}</style>' +
      content +
      '</html>',
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
export function finalize(response: Response, cleanup: () => Promise<void>) {
  if (!response.body) {
    void cleanup();
    return response;
  }
  const reader = response.body.getReader();
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          const r = await reader.read();
          if (r.done) {
            await cleanup();
            controller.close();
          } else controller.enqueue(r.value);
        } catch (e) {
          await cleanup();
          controller.error(e);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
        await cleanup();
      },
    }),
    response,
  );
}

export async function body(request: Request, maximum = 262144) {
  try {
    return JSON.parse(await textBody(request, maximum));
  } catch (e) {
    if (e instanceof CloudError) throw e;
    throw new CloudError(400, 'invalid_json');
  }
}
