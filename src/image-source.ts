import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

function imageUrl(raw: string) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('Image URL must be HTTP(S) without embedded credentials');
  return url;
}

function environmentProxy(url: URL) {
  const excluded = (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    excluded.some((part) => {
      if (part === '*') return true;
      const [name, port] = part.split(':');
      if (port && port !== (url.port || (url.protocol === 'https:' ? '443' : '80'))) return false;
      const suffix = name!.replace(/^\./, '');
      return host === suffix || host.endsWith('.' + suffix);
    })
  )
    return undefined;
  return url.protocol === 'https:'
    ? (process.env.HTTPS_PROXY ??
        process.env.https_proxy ??
        process.env.HTTP_PROXY ??
        process.env.http_proxy)
    : (process.env.HTTP_PROXY ?? process.env.http_proxy);
}

export async function imageFromUrl(
  raw: string,
  options: { maxBytes?: number; timeoutMs?: number; proxy?: string | null } = {},
): Promise<Buffer> {
  const limit = options.maxBytes ?? 16 * 1024 * 1024;
  const deadline = Date.now() + (options.timeoutMs ?? 30000);
  async function download(url: URL, redirects: number): Promise<Buffer> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('Image download timed out');
    const proxy = options.proxy === undefined ? environmentProxy(url) : options.proxy;
    return new Promise((resolve, reject) => {
      const get = url.protocol === 'https:' ? httpsGet : httpGet;
      const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
      const req = get(url, {
        agent,
        headers: { Accept: 'image/png,image/jpeg', 'User-Agent': 'Agentic-Notes/0.3' },
      });
      const timer = setTimeout(() => req.destroy(Error('Image download timed out')), remaining);
      req.on('error', reject);
      req.once('close', () => {
        clearTimeout(timer);
        agent?.destroy();
      });
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = res.headers.location;
          res.destroy();
          if (!location || redirects >= 5) {
            reject(Error('Image redirect limit exceeded'));
            return;
          }
          try {
            resolve(download(imageUrl(new URL(location, url).href), redirects + 1));
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (status !== 200) {
          res.destroy();
          reject(Error(`Image download returned HTTP ${status}`));
          return;
        }
        if (Number(res.headers['content-length'] ?? 0) > limit) {
          res.destroy();
          reject(Error('Image download exceeds size limit'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('error', reject);
        res.on('aborted', () => reject(Error('Image download interrupted')));
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit) {
            reject(Error('Image download exceeds size limit'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks, bytes)));
      });
    });
  }
  return download(imageUrl(raw), 0);
}
