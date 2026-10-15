import { createMcpHandler } from '@modelcontextprotocol/server';
import { createWishosMcp } from '../src/wishos-mcp';
import {
  CloudError,
  json,
  body,
  textBody,
  fields,
  bearer,
  tokenRoom,
  html,
  escape,
  requireOrigin,
  finalize,
  type Role,
} from './http';
export { WishosRoom } from './room';
export { WishosDirectory } from './directory';
const scope = 'wishos:devices';
const directory = (env: WishosCloudEnv) => env.DIRECTORY.getByName('directory');
const room = (env: WishosCloudEnv, id: string) => env.ROOMS.getByName(id);
async function authorized(request: Request, env: WishosCloudEnv, roles: Role[]) {
  const token = bearer(request),
    stub = room(env, tokenRoom(token)!);
  const grant = await stub.check(token, roles);
  if (!grant) throw new CloudError(401, 'invalid_or_expired_grant');
  return { stub, grant, token };
}
async function limited(request: Request, env: WishosCloudEnv) {
  const result = await env.PAIR_RATE.limit({
    key:
      new URL(request.url).pathname + ':' + (request.headers.get('CF-Connecting-IP') ?? 'unknown'),
  });
  if (!result.success) throw new CloudError(429, 'try_again_later');
}
async function issueTokens(env: WishosCloudEnv, id: string, client: string, scopes: string[]) {
  const stub = room(env, id),
    access = await stub.issue({ role: 'mcp', client, scopes, expires: Date.now() + 3600000 }),
    refresh = await stub.issue({
      role: 'refresh',
      client,
      scopes,
      expires: Date.now() + 30 * 86400000,
    });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refresh,
    scope: scopes.join(' '),
  };
}
async function fetchHandler(
  request: Request,
  env: WishosCloudEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url),
    issuer = env.PUBLIC_ORIGIN;
  if (url.pathname === '/healthz')
    return json({
      ok: true,
      service: 'wishos-connect',
      protocols: ['2026-07-28', '2025-11-25'],
      model_credentials: false,
      transcript_storage: false,
    });
  if (request.method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers':
          'Authorization,Content-Type,MCP-Protocol-Version,MCP-Method,MCP-Name',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      },
    });
  if (url.pathname === '/.well-known/oauth-authorization-server')
    return json({
      issuer,
      authorization_endpoint: issuer + '/oauth/authorize',
      token_endpoint: issuer + '/oauth/token',
      registration_endpoint: issuer + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [scope],
      authorization_response_iss_parameter_supported: true,
    });
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
    return json({
      resource: issuer + '/mcp',
      authorization_servers: [issuer],
      scopes_supported: [scope],
      bearer_methods_supported: ['header'],
    });
  if (url.pathname === '/')
    return html(
      '<h1>WishOS</h1><p>连接设备，使用你自己的 Agent。</p><small>在 WishOS 连接器的网页向导中配对设备，再将 MCP 地址添加到你的 Agent。模型凭据和对话由你选择的运行器管理。</small><p><code>' +
        escape(issuer + '/mcp') +
        '</code></p>',
    );
  if (url.pathname === '/oauth/register' && request.method === 'POST') {
    await limited(request, env);
    return json(await directory(env).registerClient(await body(request, 16384)), 201);
  }
  if (url.pathname === '/oauth/authorize') {
    const parameters =
      request.method === 'POST'
        ? new URLSearchParams(await textBody(request, 16384))
        : url.searchParams;
    const clientId = parameters.get('client_id') ?? '',
      redirect = parameters.get('redirect_uri') ?? '',
      challenge = parameters.get('code_challenge') ?? '',
      state = parameters.get('state') ?? '';
    const client = await directory(env).client(clientId, redirect);
    if (
      parameters.get('response_type') !== 'code' ||
      parameters.get('code_challenge_method') !== 'S256' ||
      !challenge.match(/^[A-Za-z0-9_-]{43}$/) ||
      (parameters.get('scope') ?? scope) !== scope
    )
      throw new CloudError(400, 'authorization_request');
    if (request.method === 'POST') {
      requireOrigin(request);
      await limited(request, env);
      if (parameters.get('consent') !== 'connect') throw new CloudError(400, 'consent_required');
      const pairing = await directory(env).consumePair(parameters.get('pairing_code') ?? '', 'mcp');
      const code = await directory(env).issueCode({
        room: pairing.room,
        client: clientId,
        redirect,
        challenge,
        scopes: [scope],
      });
      const location = new URL(redirect);
      location.searchParams.set('code', code);
      location.searchParams.set('iss', issuer);
      if (state) location.searchParams.set('state', state);
      return Response.redirect(location.toString(), 302);
    }
    const hidden = [...parameters.entries()]
      .filter(([k]) => k !== 'pairing_code' && k !== 'consent')
      .map(([k, v]) => '<input type="hidden" name="' + escape(k) + '" value="' + escape(v) + '">')
      .join('');
    return html(
      '<h1>连接 WishOS</h1><p>' +
        escape(client.client_name) +
        ' 请求访问你配对的设备。</p><small>允许发现设备、调用设备系统服务和传送资源。此授权不提供你的模型账号或 API Key。</small><form method="post">' +
        hidden +
        '<label>连接器中显示的授权码<input name="pairing_code" required autocomplete="off" maxlength="12" placeholder="ABCD-EFGH"></label><button name="consent" value="connect">连接设备</button></form><p><small>返回到：' +
        escape(redirect) +
        '</small></p>',
    );
  }
  if (url.pathname === '/oauth/token' && request.method === 'POST') {
    await limited(request, env);
    const data = new URLSearchParams(await textBody(request, 16384)),
      client = data.get('client_id') ?? '';
    if (data.get('grant_type') === 'authorization_code') {
      const grant = await directory(env).redeemCode(
        data.get('code') ?? '',
        client,
        data.get('redirect_uri') ?? '',
        data.get('code_verifier') ?? '',
      );
      return json(await issueTokens(env, grant.room, client, grant.scopes));
    }
    if (data.get('grant_type') === 'refresh_token') {
      const refresh = data.get('refresh_token') ?? '',
        id = tokenRoom(refresh);
      if (!id) throw new CloudError(400, 'invalid_grant');
      const grant = await room(env, id).rotateRefresh(refresh, client);
      return json(await issueTokens(env, id, client, grant.scopes));
    }
    throw new CloudError(400, 'unsupported_grant_type');
  }
  if (url.pathname === '/v1/installations' && request.method === 'POST') {
    requireOrigin(request);
    await limited(request, env);
    const data = await body(request, 4096);
    fields(data, ['id', 'label', 'hostname', 'port', 'pairing_seed']);
    if (
      typeof data.label !== 'string' ||
      !data.label ||
      data.label.length > 64 ||
      typeof data.hostname !== 'string' ||
      !data.hostname.match(/^[a-z0-9-]{1,63}\.local$/) ||
      !Number.isInteger(data.port) ||
      data.port < 1 ||
      data.port > 65535
    )
      throw new CloudError(400, 'installation_fields');
    if (data.id !== undefined && (typeof data.id !== 'string' || !data.id.match(/^[a-f0-9-]{36}$/)))
      throw new CloudError(400, 'installation_identity');
    if (
      data.pairing_seed !== undefined &&
      (typeof data.pairing_seed !== 'string' || !data.pairing_seed.match(/^[A-Za-z0-9_-]{43}$/))
    )
      throw new CloudError(400, 'pairing_seed');
    const id = data.id ?? crypto.randomUUID(),
      tokens = await room(env, id).initialize(
        id,
        data.label,
        data.hostname,
        data.port,
        data.pairing_seed,
      );
    return json(
      {
        room_id: id,
        owner_token: tokens.ownerToken,
        connector_token: tokens.connectorToken,
        mcp_url: issuer + '/mcp',
        relay_origin: env.RELAY_ORIGIN,
      },
      201,
    );
  }
  if (url.pathname === '/v1/pair/claim' && request.method === 'POST') {
    requireOrigin(request);
    await limited(request, env);
    const data = await body(request, 4096);
    fields(data, ['code']);
    if (typeof data.code !== 'string') throw new CloudError(400, 'pair_code');
    const pairing = await directory(env).consumePair(data.code, 'device');
    return json(await room(env, pairing.room).profile(pairing.device!));
  }
  if (['/os/device', '/v1/connector', '/v1/device-tunnel'].includes(url.pathname)) {
    const auth = await authorized(
      request,
      env,
      url.pathname === '/os/device' ? ['device'] : ['connector'],
    );
    if (request.headers.has('Origin')) throw new CloudError(403, 'device_origin_rejected');
    return auth.stub.fetch(request);
  }
  if (url.pathname === '/mcp') {
    const { stub, grant, token } = await authorized(request, env, ['mcp']);
    if (!grant.scopes.includes(scope)) throw new CloudError(403, 'insufficient_scope');
    const handler = createMcpHandler(
      () =>
        createWishosMcp(
          async (path, payload) => ({
            content: [{ type: 'text', text: JSON.stringify(await stub.api(path, payload)) }],
          }),
          { imagePreparation: false },
        ),
      { legacy: 'stateless', maxRequestBodySize: 2097152, maxSubscriptions: 4 },
    );
    try {
      return finalize(
        await handler.fetch(request, {
          authInfo: {
            token,
            clientId: grant.client ?? 'paired-client',
            scopes: grant.scopes,
            expiresAt: Math.floor(grant.expires / 1000),
          },
        }),
        () => handler.close(),
      );
    } catch (error) {
      await handler.close();
      throw error;
    }
  }
  const auth = await authorized(request, env, ['owner']);
  requireOrigin(request);
  if (url.pathname === '/v1/installations' && request.method === 'GET')
    return json(await auth.stub.publicStatus());
  if (url.pathname === '/v1/installations' && request.method === 'DELETE') {
    await auth.stub.remove();
    return json({ removed: true });
  }
  if (url.pathname === '/v1/devices' && request.method === 'POST') {
    const data = await body(request, 4096);
    fields(data, ['id', 'label']);
    if (typeof data.id !== 'string' || typeof data.label !== 'string')
      throw new CloudError(400, 'device_fields');
    await auth.stub.addDevice(data.id, data.label);
    return json(await auth.stub.profile(data.id), 201);
  }
  if (url.pathname === '/v1/devices/profile' && request.method === 'POST') {
    const data = await body(request, 4096);
    fields(data, ['id']);
    if (typeof data.id !== 'string') throw new CloudError(400, 'device_fields');
    return json(await auth.stub.profile(data.id));
  }
  if (url.pathname === '/v1/pair/code' && request.method === 'POST') {
    const data = await body(request, 4096);
    fields(data, ['purpose', 'device_id']);
    if (!['device', 'mcp'].includes(String(data.purpose)))
      throw new CloudError(400, 'pair_purpose');
    if (data.purpose === 'device' && typeof data.device_id !== 'string')
      throw new CloudError(400, 'pair_device');
    if (data.purpose === 'device') await auth.stub.profile(data.device_id);
    return json(
      await directory(env).pairCode({
        room: tokenRoom(auth.token)!,
        purpose: data.purpose,
        device: data.device_id,
      }),
    );
  }
  if (url.pathname === '/v1/access' && request.method === 'POST')
    return json({
      token: await auth.stub.issue({
        role: 'mcp',
        scopes: [scope],
        expires: Date.now() + 365 * 86400000,
      }),
      mcp_url: issuer + '/mcp',
    });
  throw new CloudError(404, 'not_found');
}
export default {
  async fetch(request: Request, env: WishosCloudEnv, ctx: ExecutionContext) {
    try {
      return await fetchHandler(request, env, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_error',
        match = message.match(/wishos:(\d{3}):([a-z0-9_:-]+)/),
        status = match ? Number(match[1]) : 500,
        code = match?.[2] ?? 'internal_error';
      return json(
        { error: code },
        status,
        status === 401
          ? {
              'WWW-Authenticate':
                'Bearer resource_metadata="' +
                env.PUBLIC_ORIGIN +
                '/.well-known/oauth-protected-resource/mcp"',
            }
          : {},
      );
    }
  },
} satisfies ExportedHandler<WishosCloudEnv>;
