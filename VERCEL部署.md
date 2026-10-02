# Vercel + Cloudflare 双入口

**国内走 Vercel、国外走 Cloudflare** 的配置已实现，详见 [地区分流.md](./地区分流.md)。在下方两个环境变量之外，新增 `CLOUDFLARE_PUBLIC_URL=https://62class.cc.cd`，然后分享 Vercel 入口网址。

现在可以同时通过 Cloudflare Worker 和 Vercel 访问同一个班级通讯录。Vercel 在服务器端转发请求给 Worker，手机访问 Vercel 时不会直接请求 Cloudflare。姓名、头像、微信号、学号和管理员登录均使用现有 Worker 与 D1。

## 先更新 Cloudflare

1. 用本项目最新的 `worker.js` 全部替换 Cloudflare Worker 的代码并部署。
2. 保留原来的 `DB` 数据库绑定，以及 `ADMIN_PASSWORD`、`SESSION_SECRET` 两个密钥。无需新建数据库，原来添加的同学资料也会继续使用。
3. 找到该 Worker 的原始 HTTPS 网址，格式为 `https://你的worker.你的子域.workers.dev`。在 Cloudflare Worker 的 Domains & Routes 页面查找。
4. 原始 `workers.dev` 入口要保持启用，Vercel 将连接它。不要把它设置为 Vercel 的重定向。

## 在 Vercel 部署

1. 将整个项目上传到一个 GitHub 仓库，至少包含 `api/gateway.js`、`vercel.json`、`package.json`。**不要只上传 `worker.js`**。项目没有 npm 依赖，无需构建前端。
2. 在 Vercel 新建项目并导入该仓库。
3. Framework Preset 选 **Other**，Root Directory 使用项目根目录。不要设置 Output Directory；不要填写自定义 Build Command。使用项目内的 `vercel.json` 路由配置。
4. 在 Vercel 项目的 **Environment Variables** 配置以下 **两个**值，启用 Production（需要预览站点时也启用 Preview）：

| 名称 | 要填的值 |
| --- | --- |
| `CLOUDFLARE_WORKER_URL` | 上面找到的原始 Worker HTTPS 网址。只填网址根地址，不带 `/admin` 或其他路径。 |
| `SESSION_SECRET` | **复制 Cloudflare 已经设置的同一串 `SESSION_SECRET`**，不要重新随机生成。 |

5. 点击 Deploy。如果项目已经部署，添加变量后需要 Redeploy。
6. 打开 Vercel 分配的 `https://项目名称.vercel.app`。

**Vercel 不需要填写 `ADMIN_PASSWORD`，也不用再创建 D1 数据库。** admin 登录密码仍是原来在 Cloudflare 设置的密码。密钥不要上传到 GitHub；`.env.example` 只有占位示例，真实值在平台设置中填写。若已无法查看原来的 `SESSION_SECRET`，可在两边同时改成新的同一串随机密钥，再部署两边；这会让原来的登录会话过期。

## 两个入口如何使用

| 入口 | 地址 |
| --- | --- |
| 现有 Cloudflare 网站 | `https://62class.cc.cd`（如果仍绑定原来的 Worker） |
| Vercel 网站 | Vercel 分配的 `https://项目名称.vercel.app` |
| 后台 | 在任一入口地址后加 `/admin` |
| 同学个人页 | 在任一入口地址后加 `/students/同学唯一编号` |

两个入口展示的是同一套资料。从任一后台新增、编辑、删除后，另一个入口刷新就能看到。后台登录状态按域名保存，因此换入口时需要再次登录。个人资料编号在两个入口相同，页面复制的链接会使用当前入口的域名。

先把两个完整网址提供给同学，让他们选择能打开的入口。Vercel 建站完成后，可以在 Vercel 的 Domains 中绑定另一个你能管理 DNS 的域名，并根据 Vercel 提示设置 DNS。不要把同一个域名的普通 CNAME 同时写成两个平台；这不能提供可靠的分流。

本项目支持 **Vercel 入口按国家跳转**，两平台共用一个后台。尚未配置保持同一域名的 DNS 地区分流或自动故障切换，后者需要额外的 DNS 调度或负载均衡配置。不要在确认 Vercel 能访问前移除现有 Cloudflare 入口。

## 实际限制

Vercel 入口能改变用户连接网站的线路，但仍需要 Vercel 服务器能够连接 Cloudflare Worker。Cloudflare Worker 或 D1 整体不可用时，Vercel 入口也会不可用。不能保证移动网络或微信一定可以访问，部署后需要实际测试。

`CLOUDFLARE_WORKER_URL` 不能填写 Vercel 自己的网址或一个已经转到 Vercel 的域名，否则会产生循环转发。推荐始终使用原始 `workers.dev` 地址。

## 本地验证

需要 Node.js 24，不需要安装依赖：

```text
npm test
npm run test:browser
npm run test:vercel-browser
```

浏览器验证需要 Windows 上已安装 Microsoft Edge。它们使用测试资料和本地模拟数据库，不修改线上数据。

若要本地预览 Vercel 转发入口，先在终端设置真实的 `CLOUDFLARE_WORKER_URL`、与 Worker 相同的 `SESSION_SECRET`，然后运行 `npm run dev`，打开 `http://localhost:3000`。本地预览连接真实 Worker，在后台的修改会影响线上资料。
