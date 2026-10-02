import { createHmac } from 'node:crypto';

const MAX_BODY = 320 * 1024;
const UUID = '[a-f0-9-]{36}';
const PATHS = new RegExp('^(?:/|/admin|/students/' + UUID + '|/api/(?:me|login|logout|students(?:/' + UUID + ')?))$');
const RESPONSE_HEADERS = ['content-type', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'retry-after'];

function errorResponse(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}

function requestedPath(req) {
  // Vercel routes pass the original pathname explicitly; local server uses req.url.
  const routed = req.query?.__route;
  if (routed !== undefined) {
    if (typeof routed !== 'string') return null;
    return '/' + routed.replace(/^\/+/, '');
  }
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) return null;
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/gateway' && url.searchParams.has('__route')) {
    return '/' + url.searchParams.get('__route').replace(/^\/+/, '');
  }
  return url.pathname;
}

function publicOrigin(req, local) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^[a-z0-9.\-]+(?::\d+)?$/i.test(host)) throw new Error('Invalid Host');
  const protocol = local ? 'http:' : 'https:';
  return new URL(protocol + '//' + host).origin;
}

async function bodyBytes(req) {
  // Vercel may already have parsed JSON; native local requests remain streams.
  if (req.body !== undefined) {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (body.length > MAX_BODY) throw new Error('too large');
    return body;
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY) throw new Error('too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function createGateway({ env = process.env, fetcher = fetch, local = false } = {}) {
  return async function gateway(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const method = req.method || 'GET';
    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method)) {
      res.setHeader('Allow', 'GET, HEAD, POST, PUT, DELETE');
      return errorResponse(res, 405, '不支持此请求方式。');
    }
    const path = requestedPath(req);
    if (!path || !PATHS.test(path)) return errorResponse(res, 404, '页面不存在。');
    let upstream, origin;
    try {
      upstream = new URL(env.CLOUDFLARE_WORKER_URL);
      origin = publicOrigin(req, local);
      if (upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== '/' || (upstream.protocol !== 'https:' && !(local && upstream.protocol === 'http:'))) throw new Error('Invalid Worker URL');
      if (upstream.origin === origin) throw new Error('Proxy loop');
    } catch {
      return errorResponse(res, 503, '请在 Vercel 环境变量中设置 CLOUDFLARE_WORKER_URL，填写原始 Worker 的 HTTPS 网址，不要填写 Vercel 自己的域名。');
    }
    // A configured entry on Vercel keeps CN/unknown visitors here and sends
    // known non-CN page visits directly to the existing Cloudflare site.
    // API requests stay on their current host to preserve sessions and writes.
    const country = String(req.headers['x-vercel-ip-country'] || '').toUpperCase();
    if (env.CLOUDFLARE_PUBLIC_URL) {
      let destination;
      try {
        destination = new URL(env.CLOUDFLARE_PUBLIC_URL);
        if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash || destination.pathname !== '/' || destination.origin === origin) throw new Error('Invalid redirect target');
      } catch {
        return errorResponse(res, 503, 'CLOUDFLARE_PUBLIC_URL 必须是 Cloudflare 的 HTTPS 根地址，并且不能是当前 Vercel 入口。');
      }
      if (/^[A-Z]{2}$/.test(country) && country !== 'CN' && ['GET', 'HEAD'].includes(method) && !path.startsWith('/api/')) {
        destination.pathname = path;
        const query = new URL(req.url, origin).searchParams;
        query.delete('__route');
        destination.search = query.toString();
        res.statusCode = 302;
        res.setHeader('Location', destination.toString());
        // Country-dependent redirects must never be cached for other visitors.
        return res.end();
      }
    }
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return errorResponse(res, 503, '请在 Vercel 配置 SESSION_SECRET，值必须与 Cloudflare Worker 中的相同，至少 32 个字符。');
    const isWrite = !['GET', 'HEAD'].includes(method);
    if (isWrite && req.headers.origin !== origin) return errorResponse(res, 403, '请求来源不正确，请刷新页面重试。');
    if (['POST', 'PUT'].includes(method) && path !== '/api/logout' && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return errorResponse(res, 415, '请使用 JSON 格式提交。');
    let body;
    if (isWrite) {
      try { body = await bodyBytes(req); }
      catch { return errorResponse(res, 413, '图片或提交内容过大。'); }
    }
    const headers = new Headers();
    if (req.headers.cookie) headers.set('Cookie', req.headers.cookie);
    if (req.headers['content-type']) headers.set('Content-Type', req.headers['content-type']);
    if (isWrite) headers.set('Origin', upstream.origin);
    // Keep per-person login limits rather than grouping all visitors under Vercel's IP.
    // Only trust Vercel's platform header, never user-supplied forwarding headers.
    const client = String(local ? (req.socket?.remoteAddress || 'local') : (req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown')).split(',')[0].trim();
    const time = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', env.SESSION_SECRET).update(client + '\n' + time).digest('base64url');
    headers.set('X-Directory-Client', client);
    headers.set('X-Directory-Time', time);
    headers.set('X-Directory-Signature', signature);
    try {
      const response = await fetcher(new URL(path, upstream), {
        method, headers, body: body?.length ? body : undefined,
        redirect: 'manual', signal: AbortSignal.timeout(20000),
      });
      if (response.status >= 300 && response.status < 400) return errorResponse(res, 502, 'Worker 返回了跳转，请检查是否填写了原始 workers.dev 地址。');
      const bytes = method === 'HEAD' ? null : Buffer.from(await response.arrayBuffer());
      res.statusCode = response.status;
      for (const name of RESPONSE_HEADERS) if (response.headers.has(name)) res.setHeader(name, response.headers.get(name));
      // Worker session cookies are host-only, so the browser stores them on Vercel.
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.end(bytes);
    } catch {
      return errorResponse(res, 502, 'Vercel 暂时无法连接 Cloudflare Worker，请稍后重试或使用 Cloudflare 入口。');
    }
  };
}

export default createGateway();
