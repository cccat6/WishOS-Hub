import type { HubApi } from './mcp-tools.js';
export function hubApi(base: string, token = ''): HubApi {
  return async (path, body) => {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (data?.payload?.op === 'display_rle' && typeof data.payload.data === 'string') {
      data.payload = {
        op: 'display_rle',
        bytes: Buffer.from(data.payload.data, 'base64').length,
        refresh_profile: data.payload.refresh_profile,
      };
    }
    if (!response.ok) throw Error(`Hub returned ${response.status}: ${JSON.stringify(data)}`);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  };
}
