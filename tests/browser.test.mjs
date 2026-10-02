// Browser integration check using the installed Edge; no npm packages required.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../api/gateway.js';

const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const sqlite = new DatabaseSync(':memory:');
const env = {
  ADMIN_PASSWORD: 'local-browser-test-password', SESSION_SECRET: 'local-browser-test-secret-32-characters',
  DB: { prepare(sql) { const statement = sqlite.prepare(sql); const wrap = args => ({
    bind: (...values) => wrap(values),
    async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
    async first() { return statement.get(...args) || null; },
    async all() { return { results: statement.all(...args) }; },
  }); return wrap([]); } },
};
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const request = new Request('http://localhost:' + server.address().port + incoming.url, {
      method: incoming.method, headers: incoming.headers, ...(body.length ? { body } : {}),
    });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { outgoing.writeHead(500); outgoing.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const vercelMode = process.argv.includes('--vercel');
const proxy = vercelMode ? createServer(createGateway({ env: { CLOUDFLARE_WORKER_URL: 'http://localhost:' + server.address().port, SESSION_SECRET: env.SESSION_SECRET }, local: true })) : null;
if (proxy) await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const siteOrigin = 'http://localhost:' + (proxy || server).address().port;
const directory = await mkdtemp(join(tmpdir(), 'class-directory-browser-'));
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + directory,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket;
const browserErrors = [];
try {
  let port;
  for (let index = 0; index < 100; index++) {
    try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, 'Edge should start');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let counter = 0;
  const waiting = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const callbacks = waiting.get(message.id); waiting.delete(message.id); if (callbacks) { clearTimeout(callbacks.timer); message.error ? callbacks.reject(new Error(message.error.message)) : callbacks.resolve(message.result); } }
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') browserErrors.push(message.params.entry.text);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++counter; const timer = setTimeout(() => { waiting.delete(id); reject(new Error(method + ' timed out')); }, 12000); waiting.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
  const until = async expression => { for (let index = 0; index < 100; index++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Condition timed out: ' + expression); };
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: siteOrigin });
  await until("document.getElementById('emptyTitle')?.textContent === '通讯录等待第一位同学'");
  assert.equal(await evaluate("document.querySelector('h1').textContent"), '6（2）班通讯录');
  assert.equal(await evaluate("document.getElementById('adminPanel').hidden"), true);
  assert.equal(await evaluate("document.getElementById('loginButton').getAttribute('href')"), '/admin');
  await cdp('Page.navigate', { url: siteOrigin + '/admin' });
  await until("location.pathname === '/admin' && document.getElementById('loginDialog')?.open");
  assert.equal(await evaluate("document.getElementById('adminPanel').hidden"), true);
  await evaluate("document.getElementById('passwordInput').value = 'local-browser-test-password'; document.getElementById('loginForm').requestSubmit()");
  await until("!document.getElementById('adminPanel').hidden");
  const png = await evaluate("(() => {const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.fillStyle='#277b50';x.fillRect(0,0,64,64);return c.toDataURL('image/png').split(',')[1]})()");
  const avatarFile = join(directory, 'avatar.png'); await writeFile(avatarFile, Buffer.from(png, 'base64'));
  const { root } = await cdp('DOM.getDocument'); const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#avatarInput' });
  await cdp('DOM.setFileInputFiles', { nodeId, files: [avatarFile] });
  await until("!document.getElementById('avatarPreview').hidden && !document.getElementById('saveButton').disabled");
  await evaluate("const f=document.getElementById('studentForm'); f.elements.name.value='测试同学'; f.elements.studentId.value='01'; f.elements.wechat.value='test_wechat'; f.requestSubmit()");
  await until("document.querySelectorAll('.card').length === 1");
  assert.equal(await evaluate("document.querySelector('.card h3').textContent"), '测试同学');
  const profilePath = await evaluate("document.querySelector('.profile-link').getAttribute('href')");
  assert.match(profilePath, /^\/students\/[a-f0-9-]{36}$/);
  await until("document.querySelector('.card .avatar').complete && document.querySelector('.card .avatar').naturalWidth === 192");
  await cdp('Page.reload');
  await until("document.querySelectorAll('.card').length === 1 && !document.getElementById('adminPanel').hidden");
  await evaluate("document.querySelector('.card-actions button').click(); document.getElementById('studentForm').elements.wechat.value='changed_wechat'; document.getElementById('studentForm').requestSubmit()");
  await until("document.querySelector('.wechat-value').textContent === 'changed_wechat'");
  await cdp('Page.navigate', { url: siteOrigin });
  await until("location.pathname === '/' && document.querySelector('.wechat-value')?.textContent === 'changed_wechat'");
  assert.equal(await evaluate("document.getElementById('adminPanel').hidden && document.querySelectorAll('.card-actions').length === 0"), true);
  await cdp('Page.navigate', { url: siteOrigin + '/admin' });
  await until("location.pathname === '/admin' && !document.getElementById('adminPanel')?.hidden");
  await evaluate("document.getElementById('logoutButton').click()");
  await until("document.getElementById('adminPanel').hidden && document.getElementById('loginDialog').open");
  const guestResponse = await evaluate("fetch('/api/me').then(r=>r.json())"); assert.equal(guestResponse.admin, false);
  await cdp('Page.navigate', { url: siteOrigin + profilePath });
  await until("document.getElementById('wechat')?.textContent === 'changed_wechat'");
  assert.equal(await evaluate("document.querySelector('h1').textContent"), '测试同学');
  await cdp('Page.reload');
  await until("document.getElementById('wechat')?.textContent === 'changed_wechat'");
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile profile should not scroll horizontally');
  await cdp('Page.navigate', { url: siteOrigin });
  await until("document.querySelector('.wechat-value')?.textContent === 'changed_wechat'");
  assert.equal(await evaluate("document.querySelector('.wechat-value').textContent"), 'changed_wechat');
  await evaluate("document.getElementById('search').value='不存在'; document.getElementById('search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 0);
  await evaluate("document.getElementById('search').value=''; document.getElementById('search').dispatchEvent(new Event('input'))");
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile page should not scroll horizontally');
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(join(directory, 'mobile.png'), Buffer.from(screenshot.data, 'base64'));
  assert.deepEqual(browserErrors, [], 'Browser should have no script, CSP or network errors');
  console.log('PASS: /admin login, image upload, add, edit, refresh persistence, logout, homepage admin separation, public profile links and refresh, search, mobile layout.');
  console.log('Preview: ' + join(directory, 'mobile.png'));
  console.log('Entrance: ' + (vercelMode ? 'Vercel proxy -> Worker' : 'Direct Worker'));
} finally {
  socket?.close(); edge.kill(); if (proxy) await new Promise(resolve => proxy.close(resolve)); await new Promise(resolve => server.close(resolve)); sqlite.close();
}
