import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Script } from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const ORIGIN = 'https://class.example';
const avatar = 'data:image/jpeg;base64,' + btoa('\xff\xd8\xff\xd9');

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const wrap = args => ({
        bind: (...values) => wrap(values),
        async run() { const result = statement.run(...args); return { meta: { changes: Number(result.changes) } }; },
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; },
      });
      return wrap([]);
    },
  };
  const env = { DB, ADMIN_PASSWORD: 'test-password-123', SESSION_SECRET: 'local-test-session-secret-32-characters' };
  async function request(path, { method = 'GET', body, cookie, origin = ORIGIN, ip = '127.0.0.1' } = {}) {
    const headers = { Origin: origin, 'CF-Connecting-IP': ip };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  }
  async function login() {
    const response = await request('/api/login', { method: 'POST', body: { username: 'admin', password: env.ADMIN_PASSWORD } });
    assert.equal(response.status, 200);
    return response.headers.get('Set-Cookie').split(';')[0];
  }
  return { env, sqlite, request, login };
}

test('single file serves the specified heading and executable browser script', async () => {
  const { request } = fixture();
  const response = await request('/');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<h1>6（2）班通讯录<\/h1>/);
  assert.match(html, /made by gpt 6\.1 sol/);
  const [, nonce, script] = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(!html.includes('__NONCE__'));
  assert.ok(response.headers.get('Content-Security-Policy').includes("'nonce-" + nonce + "'"));
  new Script(script);
});

test('visitors can browse but cannot create, edit, or delete records', async () => {
  const { request } = fixture();
  assert.deepEqual(await (await request('/api/students')).json(), []);
  assert.deepEqual(await (await request('/api/me')).json(), { admin: false });
  assert.equal((await request('/api/students', { method: 'POST', body: {} })).status, 401);
  for (const method of ['PUT', 'DELETE']) assert.equal((await request('/api/students/00000000-0000-4000-8000-000000000000', { method, body: {} })).status, 401);
});

test('password and session verification reject wrong credentials and shortened signatures', async () => {
  const { request, login } = fixture();
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'guest', password: 'test-password-123' } })).status, 401);
  const cookie = await login();
  assert.deepEqual(await (await request('/api/me', { cookie })).json(), { admin: true });
  assert.deepEqual(await (await request('/api/me', { cookie: cookie.slice(0, -1) })).json(), { admin: false });
  const changed = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  assert.deepEqual(await (await request('/api/me', { cookie: changed })).json(), { admin: false });
});

test('admin CRUD persists records, rejects duplicate school numbers and invalid avatars', async () => {
  const { request, login } = fixture();
  const cookie = await login();
  const student = { name: '测试同学', studentId: '01', wechat: 'test_wechat', avatar };
  const added = await request('/api/students', { method: 'POST', cookie, body: student });
  assert.equal(added.status, 201);
  const record = await added.json();
  assert.equal((await request('/api/students', { method: 'POST', cookie, body: student })).status, 409);
  assert.equal((await request('/api/students', { method: 'POST', cookie, body: { ...student, studentId: '02', avatar: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await request('/api/students', { method: 'POST', cookie, body: { ...student, studentId: '02', avatar: 'data:image/jpeg;base64,AAAA' } })).status, 400);
  assert.equal((await request('/api/students', { method: 'POST', cookie, body: { ...student, name: ' ' } })).status, 400);
  const changed = { ...student, name: '<img src=x onerror=alert(1)>', wechat: 'updated_wechat' };
  const updated = await request('/api/students/' + record.id, { method: 'PUT', cookie, body: changed });
  assert.equal(updated.status, 200);
  const publicList = await (await request('/api/students')).json();
  assert.equal(publicList.length, 1);
  assert.equal(publicList[0].wechat, 'updated_wechat');
  assert.equal(publicList[0].name, changed.name);
  assert.equal((await request('/api/students/' + record.id, { method: 'DELETE', cookie })).status, 200);
  assert.deepEqual(await (await request('/api/students')).json(), []);
  assert.equal((await request('/api/students/' + record.id, { method: 'DELETE', cookie })).status, 404);
});

test('cross-origin writes are rejected; logout expires the browser cookie', async () => {
  const { request, login } = fixture();
  const cookie = await login();
  assert.equal((await request('/api/students', { method: 'POST', cookie, origin: 'https://other.example', body: {} })).status, 403);
  const response = await request('/api/logout', { method: 'POST', cookie });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Strict; Max-Age=0/);
});

test('login attempts are limited and configuration gaps are clear', async () => {
  const { env, request } = fixture();
  for (let index = 0; index < 8; index++) assert.equal((await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  const limited = await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  env.SESSION_SECRET = '';
  assert.equal((await request('/api/login', { method: 'POST', body: {} })).status, 503);
  delete env.DB;
  assert.equal((await request('/api/students')).status, 503);
});

test('oversized request bodies are rejected', async () => {
  const { request, login } = fixture();
  const cookie = await login();
  const response = await request('/api/students', { method: 'POST', cookie, body: { name: 'x'.repeat(330 * 1024) } });
  assert.equal(response.status, 400);
});

test('admin and stable public student pages work with existing records and escape stored text', async () => {
  const { request, login } = fixture();
  assert.equal((await request('/admin')).status, 200);
  const cookie = await login();
  const create = body => request('/api/students', { method: 'POST', cookie, body });
  const first = await (await create({ name: '<script>alert(1)</script>', studentId: '01', wechat: '<img src=x onerror=alert(1)>', avatar })).json();
  const second = await (await create({ name: '同学乙', studentId: '02', wechat: 'student_b', avatar })).json();
  assert.notEqual(first.id, second.id);
  const link = '/students/' + first.id;
  const response = await request(link);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(!html.includes('student_b'));
  assert.match(html, /复制资料链接/);
  const [, nonce, script] = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  new Script(script);
  assert.ok(response.headers.get('Content-Security-Policy').includes("'nonce-" + nonce + "'"));
  assert.equal((await request('/students/' + second.id)).status, 200);
  assert.equal((await (await request('/api/students/' + first.id)).json()).name, first.name);
  await request('/api/students/' + first.id, { method: 'PUT', cookie, body: { name: '新名字', studentId: '03', wechat: 'new_wechat', avatar } });
  assert.match(await (await request(link)).text(), /新名字/);
  await request('/api/students/' + first.id, { method: 'DELETE', cookie });
  assert.equal((await request(link)).status, 404);
  assert.equal((await request('/api/students/' + first.id)).status, 404);
  assert.equal((await request('/does-not-exist')).status, 404);
});
