import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { createGateway } from '../api/gateway.js';

const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const SECRET = 'local-gateway-session-secret-32-characters';
const db = new DatabaseSync(':memory:');
const workerEnv = {
  ADMIN_PASSWORD: 'gateway-test-password', SESSION_SECRET: SECRET,
  DB: { prepare(sql) { const statement = db.prepare(sql); const wrap = args => ({
    bind: (...values) => wrap(values),
    async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
    async first() { return statement.get(...args) || null; },
    async all() { return { results: statement.all(...args) }; },
  }); return wrap([]); } },
};
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const response = await worker.fetch(new Request('http://localhost:' + upstream.address().port + req.url, { method: req.method, headers: { ...req.headers, 'CF-Connecting-IP': '192.0.2.9' }, ...(body.length ? { body } : {}) }), workerEnv);
  res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamOrigin = 'http://localhost:' + upstream.address().port;
const env = { CLOUDFLARE_WORKER_URL: upstreamOrigin, SESSION_SECRET: SECRET };
const gateway = createServer(createGateway({ env, local: true }));
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const origin = 'http://localhost:' + gateway.address().port;
after(async () => { await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => gateway.close(resolve))]); db.close(); });

async function invoke(handler, { url = '/', query, method = 'GET', body, headers = {} } = {}) {
  const req = { url, query, method, body, headers: { host: 'class.vercel.app', ...headers }, socket: { remoteAddress: '192.0.2.15' } };
  const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(value) { this.body = value ? Buffer.from(value).toString() : ''; } };
  await handler(req, res);
  return res;
}

test('Vercel parses routed paths and forwards signed visitor metadata without trusting supplied forwarding headers', async () => {
  let target, options;
  const handler = createGateway({ env: { CLOUDFLARE_WORKER_URL: 'https://test.workers.dev', SESSION_SECRET: SECRET }, fetcher: async (url, init) => { target = url; options = init; return new Response('hello', { headers: { 'content-type': 'text/html', 'content-security-policy': 'default-src none' } }); } });
  const result = await invoke(handler, { url: '/api/gateway?__route=admin', headers: { 'x-vercel-forwarded-for': '198.51.100.25', 'x-forwarded-for': 'bad-client', 'x-directory-client': 'bad-client' } });
  assert.equal(target.href, 'https://test.workers.dev/admin');
  assert.equal(options.headers.get('X-Directory-Client'), '198.51.100.25');
  const time = options.headers.get('X-Directory-Time');
  assert.equal(options.headers.get('X-Directory-Signature'), createHmac('sha256', SECRET).update('198.51.100.25\n' + time).digest('base64url'));
  assert.equal(options.redirect, 'manual');
  assert.equal(result.headers['content-security-policy'], 'default-src none');
  assert.equal(result.headers['cache-control'], 'no-store');
  await invoke(handler, { url: '/api/gateway', query: { __route: 'api/students' } });
  assert.equal(target.pathname, '/api/students');
});

test('CN and unknown visitors stay on Vercel, foreign page visits redirect with paths preserved', async () => {
  const env = { CLOUDFLARE_WORKER_URL: 'https://test.workers.dev', CLOUDFLARE_PUBLIC_URL: 'https://62class.cc.cd', SESSION_SECRET: SECRET };
  let calls = 0;
  const handler = createGateway({ env, fetcher: async () => { calls++; return new Response('proxied'); } });
  for (const country of ['CN', 'cn', '', 'invalid']) {
    const response = await invoke(handler, { headers: { 'x-vercel-ip-country': country } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'proxied');
  }
  assert.equal(calls, 4);
  const path = '/students/00000000-0000-4000-8000-000000000000';
  const foreign = await invoke(handler, { url: path + '?from=share', headers: { 'x-vercel-ip-country': 'US' } });
  assert.equal(foreign.statusCode, 302);
  assert.equal(foreign.headers.location, 'https://62class.cc.cd' + path + '?from=share');
  assert.equal(foreign.headers['cache-control'], 'no-store');
  assert.equal(calls, 4);
  const routed = await invoke(handler, { url: '/api/gateway?__route=admin&from=share', headers: { 'x-vercel-ip-country': 'HK' } });
  assert.equal(routed.headers.location, 'https://62class.cc.cd/admin?from=share');
  assert.equal((await invoke(handler, { method: 'HEAD', headers: { 'x-vercel-ip-country': 'GB' } })).statusCode, 302);
  assert.equal((await invoke(handler, { url: '/api/me', headers: { 'x-vercel-ip-country': 'US' } })).statusCode, 200);
  assert.equal((await invoke(handler, { url: '/api/logout', method: 'POST', body: '', headers: { origin: 'https://class.vercel.app', 'x-vercel-ip-country': 'US' } })).statusCode, 200);
  for (const target of ['https://class.vercel.app', 'http://62class.cc.cd', 'https://62class.cc.cd/path']) {
    const response = await invoke(createGateway({ env: { ...env, CLOUDFLARE_PUBLIC_URL: target } }));
    assert.equal(response.statusCode, 503);
  }
});

test('browser-origin checks are enforced before rewriting the origin sent to Worker', async () => {
  let called = false, forwarded;
  const handler = createGateway({ env: { CLOUDFLARE_WORKER_URL: 'https://test.workers.dev', SESSION_SECRET: SECRET }, fetcher: async (url, options) => { called = true; forwarded = options; return new Response('{}'); } });
  for (const supplied of ['https://attacker.example', undefined]) {
    const result = await invoke(handler, { url: '/api/login', method: 'POST', body: {}, headers: { origin: supplied, 'content-type': 'application/json' } });
    assert.equal(result.statusCode, 403);
  }
  assert.equal(called, false);
  const result = await invoke(handler, { url: '/api/login', method: 'POST', body: { username: 'admin' }, headers: { origin: 'https://class.vercel.app', 'content-type': 'application/json' } });
  assert.equal(result.statusCode, 200);
  assert.equal(forwarded.headers.get('Origin'), 'https://test.workers.dev');
  assert.deepEqual(JSON.parse(forwarded.body), { username: 'admin' });
});

test('invalid destinations, loops, unknown paths, redirects and network errors fail clearly', async () => {
  for (const url of ['https://class.vercel.app', 'http://test.workers.dev', 'https://user:password@test.workers.dev', 'https://test.workers.dev/nested', undefined]) {
    assert.equal((await invoke(createGateway({ env: { CLOUDFLARE_WORKER_URL: url, SESSION_SECRET: SECRET } }))).statusCode, 503);
  }
  const options = { env: { CLOUDFLARE_WORKER_URL: 'https://test.workers.dev', SESSION_SECRET: SECRET } };
  assert.equal((await invoke(createGateway(options), { url: '//attacker.example' })).statusCode, 404);
  assert.equal((await invoke(createGateway(options), { url: '/worker.js' })).statusCode, 404);
  assert.equal((await invoke(createGateway(options), { method: 'PATCH' })).statusCode, 405);
  assert.equal((await invoke(createGateway({ ...options, fetcher: async () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }) }))).statusCode, 502);
  assert.equal((await invoke(createGateway({ ...options, fetcher: async () => { throw new Error('upstream down'); } }))).statusCode, 502);
  assert.equal((await invoke(createGateway({ env: { CLOUDFLARE_WORKER_URL: 'https://test.workers.dev' } }))).statusCode, 503);
  assert.equal((await invoke(createGateway(options), { url: '/api/login', method: 'POST', body: 'x'.repeat(330 * 1024), headers: { origin: 'https://class.vercel.app', 'content-type': 'application/json' } })).statusCode, 413);
});

test('Vercel entrance and direct Cloudflare entrance share CRUD, profiles and host-only login cookies', async () => {
  const request = (path, method = 'GET', body, cookie) => fetch(origin + path, { method, headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/admin')).status, 200);
  assert.equal((await request('/api/students', 'POST', {})).status, 401);
  const login = await request('/api/login', 'POST', { username: 'admin', password: workerEnv.ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('Set-Cookie');
  assert.ok(setCookie.includes('HttpOnly; Secure; SameSite=Strict'));
  assert.ok(!setCookie.toLowerCase().includes('domain='));
  const cookie = setCookie.split(';')[0];
  assert.equal((await (await request('/api/me', 'GET', undefined, cookie)).json()).admin, true);
  const student = { name: '双入口测试', studentId: 'dual-01', wechat: 'shared_wechat', avatar: 'data:image/jpeg;base64,' + btoa('\xff\xd8\xff\xd9') };
  const saved = await (await request('/api/students', 'POST', student, cookie)).json();
  assert.ok(saved.id);
  const directList = await (await fetch(upstreamOrigin + '/api/students')).json();
  assert.ok(directList.some(s => s.id === saved.id && s.wechat === student.wechat));
  assert.equal((await request('/students/' + saved.id)).status, 200);
  assert.equal((await fetch(upstreamOrigin + '/students/' + saved.id)).status, 200);
  await request('/api/students/' + saved.id, 'PUT', { ...student, wechat: 'changed_both' }, cookie);
  assert.equal((await (await fetch(upstreamOrigin + '/api/students/' + saved.id)).json()).wechat, 'changed_both');
  assert.equal((await request('/api/students/' + saved.id, 'DELETE', undefined, cookie)).status, 200);
  assert.equal((await request('/students/' + saved.id)).status, 404);
  assert.equal((await request('/api/logout', 'POST', undefined, cookie)).status, 200);
});

test('Worker trusts signed proxy clients but ignores forged metadata', async () => {
  const url = 'https://test.workers.dev/api/login';
  async function attempt(client, validSignature, time = String(Math.floor(Date.now() / 1000))) {
    const signature = createHmac('sha256', validSignature ? SECRET : 'wrong-signing-key').update(client + '\n' + time).digest('base64url');
    return worker.fetch(new Request(url, { method: 'POST', headers: { Origin: 'https://test.workers.dev', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.99', 'X-Directory-Client': client, 'X-Directory-Time': time, 'X-Directory-Signature': signature }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) }), workerEnv);
  }
  for (let index = 0; index < 8; index++) assert.equal((await attempt('198.51.100.1', true)).status, 401);
  assert.equal((await attempt('198.51.100.1', true)).status, 429);
  assert.equal((await attempt('198.51.100.2', true)).status, 401);
  for (let index = 0; index < 8; index++) assert.equal((await attempt('203.0.113.' + index, false)).status, 401);
  assert.equal((await attempt('203.0.113.55', false)).status, 429);
  assert.equal((await attempt('198.51.100.3', true, String(Math.floor(Date.now() / 1000) - 120))).status, 429);
});
