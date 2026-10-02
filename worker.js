// Single-file deployment: paste this whole file into a Cloudflare Worker. Bind a D1 database as DB,
// and add ADMIN_PASSWORD and SESSION_SECRET as encrypted secrets.
const COOKIE = 'class_admin';
const SESSION_SECONDS = 60 * 60 * 24;
const MAX_BODY_BYTES = 320 * 1024;
const encoder = new TextEncoder();
const schema = `CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, student_id TEXT NOT NULL UNIQUE,
  wechat TEXT NOT NULL, avatar TEXT NOT NULL, created_at INTEGER NOT NULL
)`;

function reply(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function issueSession(env) {
  const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), encoder.encode('admin.' + expiry));
  return expiry + '.' + base64url(new Uint8Array(signature));
}

async function isAdmin(request, env) {
  if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD) return false;
  const token = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!token) return false;
  const match = /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || Number(match[1]) <= Math.floor(Date.now() / 1000)) return false;
  try {
    const bytes = Uint8Array.from(atob(match[2].replace(/-/g, '+').replace(/_/g, '/') + '='), char => char.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET), bytes, encoder.encode('admin.' + match[1]));
  } catch { return false; }
}

function cookie(token, age = SESSION_SECONDS) {
  return COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + age;
}

async function passwordMatches(provided, expected) {
  const [a, b] = await Promise.all([provided, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function readBody(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error('请使用 JSON 格式提交。');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('提交内容为空。');
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('图片或提交内容过大，请换一张图片。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new Error('提交内容格式不正确。'); }
}

function validateStudent(body) {
  const data = {};
  for (const [field, label, limit] of [['name', '姓名', 40], ['studentId', '学号', 30], ['wechat', '微信号', 80]]) {
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].trim().length > limit) throw new Error(label + '不能为空，且不能超过 ' + limit + ' 个字符。');
    data[field] = body[field].trim();
  }
  if (typeof body.avatar !== 'string' || body.avatar.length > 300 * 1024 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.avatar)) throw new Error('请上传微信头像。');
  try {
    const image = atob(body.avatar.slice('data:image/jpeg;base64,'.length));
    if (image.length < 4 || image.charCodeAt(0) !== 255 || image.charCodeAt(1) !== 216 || image.charCodeAt(image.length - 2) !== 255 || image.charCodeAt(image.length - 1) !== 217) throw new Error();
  } catch { throw new Error('头像格式不正确，请重新上传。'); }
  data.avatar = body.avatar;
  return data;
}

async function database(env) {
  if (!env.DB) return null;
  await env.DB.prepare(schema).run();
  return env.DB;
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>\"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[character]));
}

function studentPage(student, nonce) {
  const title = escapeHTML(student.name) + ' · 6（2）班通讯录';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title><style>
  :root{--bg:#f6f8f5;--ink:#20352a;--muted:#748477;--green:#277b50;--line:#e3e9e0}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}.wrap{width:min(560px,calc(100% - 36px));margin:0 auto;padding:28px 0 60px}.back{display:inline-block;color:var(--green);text-decoration:none;font-size:13px;margin:10px 0 40px}.card{background:#fff;border:1px solid var(--line);border-radius:22px;padding:32px;box-shadow:0 14px 40px #2441250b}.avatar{display:block;width:112px;height:112px;object-fit:cover;border-radius:28px;background:#edf4e9;margin:0 auto 22px}.name{text-align:center;font-size:30px;margin:0 0 8px}.student-id{text-align:center;color:var(--muted);font-size:13px;margin:0 0 32px}.row{border-top:1px solid var(--line);padding:20px 0}.label{font-size:11px;letter-spacing:1px;color:var(--muted);margin-bottom:8px}.value{font-size:17px;font-weight:600;overflow-wrap:anywhere}.copy{margin-top:12px;border:0;border-radius:9px;background:#edf4e9;color:var(--green);padding:10px 14px;cursor:pointer}.credit{text-align:center;color:#96a191;font-size:12px;margin-top:24px;letter-spacing:.5px}.error{text-align:center;padding-top:100px}.error h1{font-size:24px}.error p{color:var(--muted)}
  </style></head><body><main class="wrap"><a class="back" href="/">← 返回班级通讯录</a><article class="card"><img class="avatar" src="${escapeHTML(student.avatar)}" alt="${escapeHTML(student.name)}的微信头像"><h1 class="name">${escapeHTML(student.name)}</h1><p class="student-id">学号 ${escapeHTML(student.studentId)}</p><div class="row"><div class="label">WECHAT</div><div id="wechat" class="value">${escapeHTML(student.wechat)}</div><button id="copyWechat" class="copy" type="button">复制微信号</button><button id="copyLink" class="copy" type="button">复制资料链接</button></div></article><p class="credit">6（2）班通讯录 · made by gpt 6.1 sol</p></main><script nonce="${nonce}">for(const [id,value] of [['copyWechat',document.getElementById('wechat').textContent],['copyLink',location.href]]){document.getElementById(id).addEventListener('click',async event=>{try{await navigator.clipboard.writeText(value);event.target.textContent='已复制'}catch{event.target.textContent=id==='copyWechat'?'请长按微信号复制':'请复制地址栏网址'}})}</script></body></html>`;
}

function missingStudentPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>资料不存在 · 6（2）班通讯录</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f6f8f5;color:#20352a;text-align:center;padding:90px 20px}a{color:#277b50}</style></head><body><h1>找不到这位同学</h1><p>资料可能已经被管理员删除。</p><a href="/">返回班级通讯录</a></body></html>`;
}

async function loginAllowed(db, request, env) {
  await db.prepare('CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL)').run();
  const ip = await clientAddress(request, env);
  const key = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), encoder.encode(ip))));
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO login_limits (key, attempts, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END
    RETURNING attempts, reset_at`).bind(key, now + 15 * 60 * 1000, now, now, now + 15 * 60 * 1000).first();
  await db.prepare('DELETE FROM login_limits WHERE reset_at < ?').bind(now).run();
  return { allowed: row.attempts <= 8, retry: Math.max(1, Math.ceil((row.reset_at - now) / 1000)), key };
}

async function clientAddress(request, env) {
  const client = request.headers.get('X-Directory-Client');
  const time = request.headers.get('X-Directory-Time');
  const signature = request.headers.get('X-Directory-Signature');
  if (env.SESSION_SECRET && client && client.length <= 80 && /^[0-9.:[\]a-f]+$/i.test(client) && /^\d{10}$/.test(time || '') && Math.abs(Math.floor(Date.now() / 1000) - Number(time)) <= 60 && /^[A-Za-z0-9_-]{43}$/.test(signature || '')) {
    try {
      const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/') + '='), char => char.charCodeAt(0));
      if (await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET), bytes, encoder.encode(client + '\n' + time))) return client;
    } catch { /* Ignore untrusted forwarding metadata. */ }
  }
  return request.headers.get('CF-Connecting-IP') || 'local';
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET' && (path === '/' || path === '/admin')) {
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)));
    return new Response(HTML.replaceAll('__NONCE__', nonce), { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    } });
  }
  const profilePath = /^\/students\/([a-f0-9-]{36})$/.exec(path);
  if (request.method === 'GET' && profilePath) {
    const db = await database(env);
    if (!db) return new Response('D1 database binding DB is required.', { status: 503 });
    const student = await db.prepare('SELECT id, name, student_id AS studentId, wechat, avatar FROM students WHERE id = ?').bind(profilePath[1]).first();
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)));
    return new Response(student ? studentPage(student, nonce) : missingStudentPage(), { status: student ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'" } });
  }
  if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('Origin') !== url.origin) return reply({ error: '请求来源不正确，请刷新页面重试。' }, 403);
  if (request.method === 'GET' && path === '/api/me') return reply({ admin: await isAdmin(request, env) });
  if (request.method === 'POST' && path === '/api/logout') return reply({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  if (request.method === 'POST' && path === '/api/login') {
    if (!env.ADMIN_PASSWORD) return reply({ error: '尚未设置登录密码：请在此 Worker 的 Settings → Variables and Secrets 添加 ADMIN_PASSWORD 密钥并部署。' }, 503);
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return reply({ error: '尚未设置有效会话密钥：请在此 Worker 的 Settings → Variables and Secrets 添加至少 32 字符的 SESSION_SECRET 密钥并部署。' }, 503);
    const db = await database(env);
    if (!db) return reply({ error: '请先把 D1 数据库绑定为 DB。' }, 503);
    let body;
    try { body = await readBody(request); } catch (error) { return reply({ error: error.message }, 400); }
    const limit = await loginAllowed(db, request, env);
    if (!limit.allowed) return reply({ error: '尝试次数过多，请 15 分钟后重试。' }, 429, { 'Retry-After': String(limit.retry) });
    if (body.username !== 'admin' || typeof body.password !== 'string' || !(await passwordMatches(body.password, env.ADMIN_PASSWORD))) return reply({ error: '账号或密码不正确。' }, 401);
    await db.prepare('DELETE FROM login_limits WHERE key = ?').bind(limit.key).run();
    return reply({ ok: true }, 200, { 'Set-Cookie': cookie(await issueSession(env)) });
  }
  const studentPath = /^\/api\/students\/([a-f0-9-]{36})$/.exec(path);
  if (request.method === 'GET' && studentPath) {
    const db = await database(env);
    if (!db) return reply({ error: '尚未连接数据库。' }, 503);
    const student = await db.prepare('SELECT id, name, student_id AS studentId, wechat, avatar FROM students WHERE id = ?').bind(studentPath[1]).first();
    return student ? reply(student) : reply({ error: '该同学资料不存在。' }, 404);
  }
  const mutation = request.method === 'POST' && path === '/api/students' || ['PUT', 'DELETE'].includes(request.method) && studentPath;
  if (mutation && !(await isAdmin(request, env))) return reply({ error: '请先登录管理员账号。' }, 401);
  if (request.method === 'GET' && path === '/api/students') {
    const db = await database(env);
    if (!db) return reply({ error: '尚未连接数据库，请把 D1 数据库绑定为 DB。' }, 503);
    const { results } = await db.prepare('SELECT id, name, student_id AS studentId, wechat, avatar FROM students ORDER BY created_at, id').all();
    return reply(results);
  }
  if (mutation) {
    const db = await database(env);
    if (!db) return reply({ error: '尚未连接数据库。' }, 503);
    if (request.method === 'DELETE') {
      const result = await db.prepare('DELETE FROM students WHERE id = ?').bind(studentPath[1]).run();
      return result.meta.changes ? reply({ ok: true }) : reply({ error: '该同学资料已不存在。' }, 404);
    }
    let data;
    try { data = validateStudent(await readBody(request)); } catch (error) { return reply({ error: error.message }, 400); }
    const id = studentPath ? studentPath[1] : crypto.randomUUID();
    const duplicate = await db.prepare('SELECT id FROM students WHERE student_id = ? AND id != ?').bind(data.studentId, id).first();
    if (duplicate) return reply({ error: '这个学号已存在，请检查后再提交。' }, 409);
    if (request.method === 'PUT') {
      const result = await db.prepare('UPDATE students SET name = ?, student_id = ?, wechat = ?, avatar = ? WHERE id = ?').bind(data.name, data.studentId, data.wechat, data.avatar, id).run();
      if (!result.meta.changes) return reply({ error: '该同学资料已不存在。' }, 404);
    } else {
      await db.prepare('INSERT INTO students (id, name, student_id, wechat, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, data.name, data.studentId, data.wechat, data.avatar, Date.now()).run();
    }
    return reply({ id, ...data }, request.method === 'POST' ? 201 : 200);
  }
  return reply({ error: '接口不存在。' }, 404);
}

export default {
  async fetch(request, env) {
    let response;
    try { response = await handle(request, env); }
    catch (error) {
      console.error('Directory request failed:', error.message);
      response = reply({ error: '服务暂时不可用，请稍后重试。' }, 500);
    }
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Frame-Options', 'DENY');
    return response;
  },
};

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f6f8f5">
  <title>6（2）班通讯录</title>
  <style>
    :root{color-scheme:light;--bg:#f6f8f5;--ink:#20352a;--muted:#748477;--green:#277b50;--line:#e3e9e0;--light:#edf4e9}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}button,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.55;cursor:wait}button:focus-visible,a:focus-visible{outline:3px solid #a6d5b5;outline-offset:3px}input:focus{outline:2px solid #a6d5b5;outline-offset:1px}[hidden]{display:none!important}
    .shell{max-width:1120px;margin:auto;padding:0 28px}.topbar{height:84px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{display:flex;gap:10px;align-items:center;font-weight:650;font-size:15px}.brand-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--green);color:white;font-size:17px}.text-button{border:0;background:transparent;color:var(--muted);padding:10px 0 10px 14px;font-size:13px}.text-button:hover{color:var(--green)}
    .hero{padding:62px 0 42px;position:relative}.eyebrow{color:var(--green);font-size:11px;letter-spacing:2px;font-weight:700;margin:0 0 17px}.hero h1{font-size:clamp(30px,5.2vw,48px);letter-spacing:-1.7px;line-height:1.25;margin:0;font-weight:750}.credit{margin:15px 0 0;color:var(--muted);font-size:13px;letter-spacing:.8px}.hero-note{display:inline-flex;gap:9px;align-items:center;margin-top:26px;padding:8px 13px;border:1px solid #dbe8d4;border-radius:30px;background:#f0f5eb;color:#53734e;font-size:12px}.dot{width:6px;height:6px;border-radius:50%;background:#73a264}
    .directory-head{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:0 0 20px}.section-title{font-size:18px;font-weight:650;margin:0;display:flex;gap:10px;align-items:center}.count{font-size:12px;font-weight:500;color:var(--green);background:#e6f0e3;padding:3px 8px;border-radius:6px}.search{position:relative;width:300px}.search svg{width:18px;height:18px;position:absolute;top:13px;left:13px;color:var(--muted)}.search input{width:100%;height:44px;border:1px solid var(--line);border-radius:11px;background:white;padding:0 14px 0 40px;font-size:13px;color:var(--ink)}
    .cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.card{background:white;border:1px solid var(--line);border-radius:17px;padding:23px;transition:box-shadow .2s,transform .2s}.card:hover{transform:translateY(-3px);box-shadow:0 10px 26px #2441250c}.card-top{display:flex;gap:14px;align-items:center;margin-bottom:22px}.avatar{height:60px;width:60px;object-fit:cover;border-radius:16px;background:var(--light);flex-shrink:0}.card h3{font-size:18px;margin:0 0 7px;font-weight:650;overflow-wrap:anywhere}.number{font-size:11px;color:var(--muted);padding:3px 7px;background:#f6f8f3;border-radius:5px;overflow-wrap:anywhere;display:inline-block}.wechat-row{border-top:1px solid #eef1eb;padding-top:15px;display:flex;align-items:center;justify-content:space-between;gap:10px}.wechat-label{font-size:10px;letter-spacing:1px;color:var(--muted);margin-bottom:4px}.wechat-value{font-size:13px;font-weight:550;overflow-wrap:anywhere;user-select:all}.copy{border:1px solid #e6ece1;background:#f6f8f3;border-radius:9px;color:#63805b;padding:8px;display:grid;place-items:center;flex-shrink:0}.copy svg{width:15px;height:15px}.copy:hover{background:#eaf2e5}.card-actions{display:flex;gap:14px;border-top:1px solid var(--line);margin-top:16px;padding-top:12px}.card-actions button{border:0;background:none;color:var(--green);font-size:12px;padding:4px 0}.card-actions .delete{color:#b75f55}
    .empty{text-align:center;padding:58px 20px;border:1px dashed #d3dfcf;border-radius:17px;background:#ffffff66;color:var(--muted)}.empty strong{display:block;color:var(--ink);font-size:17px;margin-bottom:9px}.empty p{font-size:13px;margin:0;line-height:1.8}.admin-panel{margin-top:30px;background:white;border:1px solid var(--line);border-radius:17px;padding:26px}.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.panel-head h2{font-size:18px;margin:0}.pill{font-size:11px;color:var(--green);background:var(--light);padding:5px 9px;border-radius:6px}.editor-grid{display:grid;grid-template-columns:135px 1fr;gap:24px}.upload-label{display:flex;flex-direction:column;align-items:center;gap:9px;color:var(--muted);font-size:12px;cursor:pointer}.upload-preview{width:104px;height:104px;border:1px dashed #cddcc6;border-radius:22px;display:grid;place-items:center;background:#f5f8f1;overflow:hidden}.upload-preview img{width:100%;height:100%;object-fit:cover}.upload-preview svg{width:28px;height:28px;color:#89a97d}.upload-label:hover .upload-preview{border-color:var(--green)}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.field{display:block;font-size:12px;color:var(--muted)}.field input{display:block;width:100%;margin-top:7px;height:44px;border:1px solid var(--line);border-radius:10px;background:#fbfcfa;padding:0 12px;color:var(--ink);font-size:14px}.wide{grid-column:1/-1}.editor-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:20px}.primary{background:var(--green);color:white;border:0;border-radius:10px;font-size:13px;font-weight:600;padding:12px 20px}.primary:hover{background:#216a44}.secondary{background:#f0f3ec;border:0;border-radius:10px;color:#5d7258;font-size:13px;padding:12px 18px}.status{font-size:12px;color:#a75b50;line-height:1.7}.footer{margin:45px 0 0;border-top:1px solid var(--line);padding:22px 0 30px;display:flex;justify-content:space-between;color:#96a191;font-size:11px}.footer span:last-child{letter-spacing:1px}
    dialog{border:1px solid var(--line);border-radius:20px;width:min(380px,calc(100% - 36px));padding:28px;box-shadow:0 20px 90px #19332630;color:var(--ink)}dialog::backdrop{background:#173c2960;backdrop-filter:blur(4px)}dialog h2{font-size:22px;margin:0 0 8px}.dialog-intro{color:var(--muted);font-size:12px;margin:0 0 22px}.login-fields{display:grid;gap:15px}.dialog-actions{display:flex;gap:10px;margin-top:22px}.toast{position:fixed;bottom:25px;left:50%;transform:translateX(-50%);background:#20352a;color:white;padding:12px 20px;border-radius:12px;font-size:13px;box-shadow:0 5px 20px #20352a25;z-index:10;max-width:calc(100% - 30px);text-align:center}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}
    @media(min-width:900px){.hero:after{content:'62';position:absolute;right:20px;top:34px;font-size:142px;font-weight:800;letter-spacing:-14px;color:#e8eee1;line-height:1;transform:rotate(-7deg);pointer-events:none}}
    .text-button{text-decoration:none;display:inline-block}.card-title-link{color:inherit;text-decoration:none}.card-title-link:hover{color:var(--green)}.profile-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:15px}.profile-link,.share-link{font-size:12px;color:var(--green);text-decoration:none}.share-link{border:0;background:none;padding:0}.admin-login{position:static;margin:0 auto 30px;width:min(430px,100%);box-shadow:none;background:#fff}.admin-heading{font-size:24px;margin:0 0 24px}.home-link{color:var(--green);text-decoration:none;font-size:13px}
    @media(max-width:900px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:580px){.shell{padding:0 18px}.topbar{height:68px}.hero{padding:40px 0 30px}.directory-head{align-items:flex-start;flex-direction:column;gap:14px}.search{width:100%}.cards{grid-template-columns:1fr;gap:12px}.card{padding:20px}.editor-grid{grid-template-columns:1fr;gap:20px}.upload-label{align-items:flex-start}.fields{grid-template-columns:1fr}.wide{grid-column:auto}.admin-panel{padding:20px}.footer{gap:12px;flex-wrap:wrap}}
  </style>
</head>
<body>
  <div class="shell">
    <nav class="topbar" aria-label="顶部导航"><div class="brand"><span class="brand-mark" aria-hidden="true">✦</span>班级通讯录</div><div><a id="homeLink" class="home-link" href="/" hidden>返回通讯录</a><a id="loginButton" class="text-button" href="/admin">管理后台 ↗</a><button id="logoutButton" class="text-button" hidden>退出 admin</button></div></nav>
    <header class="hero"><p class="eyebrow">OUR CLASS · OUR CONNECTIONS</p><h1>6（2）班通讯录</h1><p class="credit">made by gpt 6.1 sol</p><div class="hero-note"><span class="dot"></span>同窗相伴，让联系更简单</div></header>
    <main>
      <h2 id="adminHeading" class="admin-heading" hidden>管理员后台</h2>
      <div class="directory-head"><h2 class="section-title">全班同学 <span id="count" class="count">0 人</span></h2><label class="search"><span class="sr-only">搜索同学</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.8" cy="10.8" r="7"></circle><path d="m16 16 5 5"></path></svg><input id="search" type="search" placeholder="搜索姓名、学号或微信号" autocomplete="off"></label></div>
      <div id="cards" class="cards"></div>
      <div id="empty" class="empty" role="status"><strong id="emptyTitle">正在加载通讯录…</strong><p id="emptyDetail">马上就好</p><button id="retryButton" class="secondary" hidden>重新加载</button></div>
      <section id="adminPanel" class="admin-panel" hidden aria-labelledby="editorTitle">
        <div class="panel-head"><h2 id="editorTitle">添加同学</h2><span class="pill">admin 后台</span></div>
        <form id="studentForm">
          <div class="editor-grid">
            <div><label class="upload-label" for="avatarInput"><span class="upload-preview"><img id="avatarPreview" alt="头像预览" hidden><svg id="uploadIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"></rect><circle cx="8" cy="8" r="1.5"></circle><path d="m3 17 5-5 4 4 4-6 5 7"></path></svg></span><span>选择微信头像</span></label><input id="avatarInput" class="sr-only" type="file" accept="image/jpeg,image/png,image/webp" aria-label="上传微信头像"></div>
            <div><div class="fields"><label class="field">姓名<input name="name" placeholder="同学姓名" maxlength="40" required></label><label class="field">学号<input name="studentId" placeholder="例如：01" maxlength="30" required></label><label class="field wide">微信号<input name="wechat" placeholder="填写同学的微信号" maxlength="80" required></label></div><div class="editor-actions"><button id="saveButton" class="primary" type="submit">添加同学</button><button id="cancelEdit" class="secondary" type="button" hidden>取消编辑</button><span id="formStatus" class="status" role="status"></span></div></div>
          </div>
        </form>
      </section>
    </main>
    <footer class="footer"><span>6（2）班 · 每一位同学，都在这里</span><span>CLASS DIRECTORY</span></footer>
  </div>
  <dialog id="loginDialog"><form id="loginForm"><h2>管理员登录</h2><p class="dialog-intro">登录后可添加、编辑和删除同学资料。</p><div class="login-fields"><label class="field">账号<input name="username" value="admin" readonly autocomplete="username"></label><label class="field">密码<input id="passwordInput" name="password" type="password" placeholder="输入管理员密码" required autocomplete="current-password"></label></div><div class="dialog-actions"><button id="submitLogin" class="primary" type="submit">登录后台</button><button id="cancelLogin" class="secondary" type="button">取消</button></div><p id="loginStatus" class="status" role="status"></p></form></dialog>
  <div id="toast" class="toast" role="status" hidden></div>
  <script nonce="__NONCE__">
    const $ = id => document.getElementById(id);
    const isAdminPage = location.pathname === '/admin';
    const state = { students: [], admin: false, avatar: '', editing: null, uploading: false };
    if (isAdminPage) {
      document.title = '管理员后台 · 6（2）班通讯录';
      $('adminHeading').hidden = false; $('homeLink').hidden = false; $('loginButton').hidden = true;
      $('loginDialog').classList.add('admin-login');
      document.querySelector('main').insertBefore($('loginDialog'), document.querySelector('.directory-head'));
      $('cancelLogin').textContent = '返回首页';
      $('loginDialog').show();
    }
    const copySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path></svg>';
    let toastTimer;
    function notify(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 2800); }
    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: options.body ? { 'Content-Type': 'application/json' } : {} });
      const data = await response.json();
      if (!response.ok) { if (response.status === 401 && path !== '/api/login') { state.admin = false; showAdmin(); } throw new Error(data.error || '请求失败，请重试。'); }
      return data;
    }
    function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
    function render() {
      document.querySelector('.directory-head').hidden = isAdminPage && !state.admin;
      if (isAdminPage && !state.admin) { $('cards').replaceChildren(); $('empty').hidden = true; return; }
      const query = $('search').value.trim().toLowerCase();
      const students = state.students.filter(s => [s.name, s.studentId, s.wechat].some(value => value.toLowerCase().includes(query))).sort((a,b) => a.studentId.localeCompare(b.studentId, 'zh-CN', { numeric: true }));
      $('count').textContent = state.students.length + ' 人';
      $('cards').replaceChildren();
      for (const s of students) {
        const card = node('article', 'card');
        const top = node('div', 'card-top');
        const image = node('img', 'avatar'); image.src = s.avatar; image.alt = s.name + '的微信头像'; image.loading = 'lazy';
        const profileUrl = '/students/' + s.id;
        const info = node('div'); const heading = node('h3'); const nameLink = node('a', 'card-title-link', s.name); nameLink.href = profileUrl; heading.append(nameLink); info.append(heading, node('span', 'number', '学号 ' + s.studentId)); top.append(image, info);
        const row = node('div', 'wechat-row'); const contact = node('div'); contact.append(node('div', 'wechat-label', '微信号'), node('div', 'wechat-value', s.wechat));
        const copy = node('button', 'copy'); copy.type = 'button'; copy.innerHTML = copySvg; copy.setAttribute('aria-label', '复制' + s.name + '的微信号'); copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(s.wechat); notify('微信号已复制'); } catch { notify('复制失败，请长按微信号手动复制'); } });
        row.append(contact, copy); card.append(top, row);
        const links = node('div', 'profile-actions'); const profile = node('a', 'profile-link', '查看个人资料 ↗'); profile.href = profileUrl;
        const share = node('button', 'share-link', '复制资料链接'); share.type = 'button'; share.addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.origin + profileUrl); notify('资料链接已复制'); } catch { notify('请打开个人资料并复制地址栏网址'); } }); links.append(profile, share); card.append(links);
        if (isAdminPage && state.admin) {
          const actions = node('div', 'card-actions'); const edit = node('button', '', '编辑资料'); const remove = node('button', 'delete', '删除');
          edit.addEventListener('click', () => beginEdit(s));
          remove.addEventListener('click', async () => { if (!confirm('确定删除「' + s.name + '」的资料吗？')) return; remove.disabled = true; try { await api('/api/students/' + s.id, { method: 'DELETE' }); state.students = state.students.filter(item => item.id !== s.id); if (state.editing === s.id) resetEditor(); render(); notify('资料已删除'); } catch (error) { notify(error.message); remove.disabled = false; } });
          actions.append(edit, remove); card.append(actions);
        }
        $('cards').append(card);
      }
      $('empty').hidden = students.length > 0; $('retryButton').hidden = true;
      $('emptyTitle').textContent = query ? '没有找到这位同学' : '通讯录等待第一位同学';
      $('emptyDetail').textContent = query ? '试试其他姓名、学号或微信号。' : '管理员登录后，即可添加同学资料。';
    }
    function showAdmin() {
      $('adminPanel').hidden = !(isAdminPage && state.admin); $('logoutButton').hidden = !(isAdminPage && state.admin);
      if (isAdminPage) { if (state.admin) $('loginDialog').close(); else if (!$('loginDialog').open) $('loginDialog').show(); }
      if (!state.admin) resetEditor(); render();
    }
    function setAvatar(value) { state.avatar = value; $('avatarPreview').hidden = !value; $('uploadIcon').hidden = !!value; if (value) $('avatarPreview').src = value; else $('avatarPreview').removeAttribute('src'); }
    function resetEditor() { state.editing = null; $('studentForm').reset(); setAvatar(''); $('editorTitle').textContent = '添加同学'; $('saveButton').textContent = '添加同学'; $('cancelEdit').hidden = true; $('formStatus').textContent = ''; }
    function beginEdit(s) { resetEditor(); state.editing = s.id; for (const key of ['name', 'studentId', 'wechat']) $('studentForm').elements[key].value = s[key]; setAvatar(s.avatar); $('editorTitle').textContent = '编辑同学资料'; $('saveButton').textContent = '保存修改'; $('cancelEdit').hidden = false; $('adminPanel').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    async function load() {
      try { const [students, me] = await Promise.all([api('/api/students'), api('/api/me')]); state.students = students; state.admin = me.admin; showAdmin(); }
      catch (error) { $('cards').replaceChildren(); $('empty').hidden = false; $('emptyTitle').textContent = '暂时无法加载通讯录'; $('emptyDetail').textContent = error.message; $('retryButton').hidden = false; }
    }
    $('search').addEventListener('input', render);
    $('retryButton').addEventListener('click', load);
    $('cancelLogin').addEventListener('click', () => { location.href = '/'; });
    $('loginDialog').addEventListener('close', () => $('loginForm').reset());
    $('loginForm').addEventListener('submit', async event => { event.preventDefault(); const button = $('submitLogin'); button.disabled = true; $('loginStatus').textContent = ''; try { await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); state.admin = true; $('loginDialog').close(); showAdmin(); notify('欢迎回来，admin'); } catch (error) { $('loginStatus').textContent = error.message; } finally { button.disabled = false; } });
    $('logoutButton').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); state.admin = false; showAdmin(); notify('已退出登录'); } catch (error) { notify(error.message); } });
    $('cancelEdit').addEventListener('click', resetEditor);
    $('avatarInput').addEventListener('change', async event => {
      const file = event.target.files[0]; if (!file) return;
      state.uploading = true; $('saveButton').disabled = true; $('formStatus').textContent = '正在处理头像…';
      try {
        if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('请上传 JPG、PNG 或 WebP 图片。');
        if (file.size > 10 * 1024 * 1024) throw new Error('原图不能超过 10 MB。');
        const bitmap = await createImageBitmap(file); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 192; const context = canvas.getContext('2d');
        context.fillStyle = '#fff'; context.fillRect(0,0,192,192); const side = Math.min(bitmap.width, bitmap.height); context.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 192, 192); bitmap.close();
        setAvatar(canvas.toDataURL('image/jpeg', .85)); $('formStatus').textContent = '';
      } catch (error) { $('formStatus').textContent = error.message || '图片读取失败，请换一张图片。'; }
      finally { state.uploading = false; $('saveButton').disabled = false; }
    });
    $('studentForm').addEventListener('submit', async event => {
      event.preventDefault(); if (state.uploading) return;
      if (!state.avatar) { $('formStatus').textContent = '请先选择微信头像。'; return; }
      const button = $('saveButton'); button.disabled = true; $('formStatus').textContent = '';
      try {
        const body = { ...Object.fromEntries(new FormData(event.currentTarget)), avatar: state.avatar };
        const saved = await api(state.editing ? '/api/students/' + state.editing : '/api/students', { method: state.editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
        const index = state.students.findIndex(s => s.id === saved.id); if (index < 0) state.students.push(saved); else state.students[index] = saved;
        resetEditor(); render(); notify('同学资料已保存');
      } catch (error) { $('formStatus').textContent = error.message; }
      finally { button.disabled = false; }
    });
    load();
  </script>
</body>
</html>`;
