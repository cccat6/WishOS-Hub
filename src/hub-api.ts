import type { HubApi } from './api-types.js';
export function hubApi(base: string, token = '', signal?: AbortSignal): HubApi {
  return async (path, body) => {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) throw Error(`Hub returned ${response.status}: ${JSON.stringify(data)}`);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  };
}
