import { DurableObject } from 'cloudflare:workers';
import { CloudError, hash, random } from './http';
export type OAuthClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none';
};
export class WishosDirectory extends DurableObject<WishosCloudEnv> {
  constructor(ctx: DurableObjectState, env: WishosCloudEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS entries(kind TEXT,key TEXT,value TEXT,expires INTEGER,PRIMARY KEY(kind,key));',
    );
  }
  private cleanup() {
    this.ctx.storage.sql.exec('DELETE FROM entries WHERE expires<?', Date.now());
  }
  private put(kind: string, key: string, value: unknown, ttl: number) {
    this.cleanup();
    this.ctx.storage.sql.exec(
      'INSERT INTO entries VALUES(?,?,?,?)',
      kind,
      key,
      JSON.stringify(value),
      Date.now() + ttl,
    );
  }
  private read<T>(kind: string, key: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>('SELECT value FROM entries WHERE kind=? AND key=? AND expires>?', kind, key, Date.now())
      .toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  private take<T>(kind: string, key: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{
        value: string;
      }>(
        'DELETE FROM entries WHERE kind=? AND key=? AND expires>? RETURNING value',
        kind,
        key,
        Date.now(),
      )
      .toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  async registerClient(input: unknown) {
    const value = input as Record<string, unknown>;
    if (
      !value ||
      !Array.isArray(value.redirect_uris) ||
      !value.redirect_uris.length ||
      value.redirect_uris.length > 8 ||
      value.redirect_uris.some((uri) => !this.redirectAllowed(uri))
    )
      throw new CloudError(400, 'invalid_redirect_uri');
    if (
      value.token_endpoint_auth_method !== undefined &&
      value.token_endpoint_auth_method !== 'none'
    )
      throw new CloudError(400, 'public_client_required');
    const client: OAuthClient = {
      client_id: 'wishos-' + crypto.randomUUID(),
      client_name:
        typeof value.client_name === 'string' ? value.client_name.slice(0, 128) : 'MCP client',
      redirect_uris: value.redirect_uris as string[],
      token_endpoint_auth_method: 'none',
    };
    this.put('client', client.client_id, client, 365 * 86400000);
    return client;
  }
  private redirectAllowed(value: unknown) {
    try {
      if (typeof value !== 'string') return false;
      const u = new URL(value);
      return (
        !u.username &&
        !u.password &&
        !u.hash &&
        (u.protocol === 'https:' ||
          (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) ||
          (u.protocol === 'workbuddy:' &&
            u.hostname === 'workbuddy' &&
            u.pathname.endsWith('/oauth/callback')))
      );
    } catch {
      return false;
    }
  }
  async client(id: string, redirect: string) {
    const client = this.read<OAuthClient>('client', id);
    if (!client) throw new CloudError(400, 'invalid_client');
    if (!this.redirectAllowed(redirect)) throw new CloudError(400, 'invalid_redirect_uri');
    const actual = new URL(redirect);
    if (
      !client.redirect_uris.some((uri) => {
        if (uri === redirect) return true;
        const registered = new URL(uri);
        return (
          registered.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(registered.hostname) &&
          !registered.port &&
          registered.hostname === actual.hostname &&
          registered.protocol === actual.protocol &&
          registered.pathname === actual.pathname &&
          registered.search === actual.search
        );
      })
    )
      throw new CloudError(400, 'redirect_mismatch');
    return client;
  }
  async pairCode(value: { room: string; purpose: 'device' | 'mcp'; device?: string }) {
    const code = Array.from(
      crypto.getRandomValues(new Uint8Array(8)),
      (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32],
    ).join('');
    this.put('pair', await hash(code), value, 600000);
    return { code: code.slice(0, 4) + '-' + code.slice(4), expires_in: 600 };
  }
  async consumePair(code: string, purpose: 'device' | 'mcp') {
    const key = await hash(code.toUpperCase().replaceAll('-', '').trim());
    const v = this.read<{ room: string; purpose: string; device?: string }>('pair', key);
    if (!v || v.purpose !== purpose) throw new CloudError(400, 'pairing_code_invalid_or_expired');
    return this.take<typeof v>('pair', key)!;
  }
  async issueCode(value: {
    room: string;
    client: string;
    redirect: string;
    challenge: string;
    scopes: string[];
  }) {
    const code = random();
    this.put('code', await hash(code), value, 300000);
    return code;
  }
  async redeemCode(code: string, client: string, redirect: string, verifier: string) {
    const key = await hash(code),
      value = this.read<{
        room: string;
        client: string;
        redirect: string;
        challenge: string;
        scopes: string[];
      }>('code', key);
    if (
      !value ||
      value.client !== client ||
      value.redirect !== redirect ||
      verifier.length < 43 ||
      verifier.length > 128
    )
      throw new CloudError(400, 'invalid_grant');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const actual = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    if (actual !== value.challenge) throw new CloudError(400, 'invalid_grant');
    const taken = this.take<typeof value>('code', key);
    if (!taken) throw new CloudError(400, 'invalid_grant');
    return taken;
  }
}
