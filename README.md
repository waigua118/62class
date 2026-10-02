# 6（2）班通讯录

同时支持 Cloudflare Worker 单文件部署，以及 Vercel 入口部署。Vercel 版本和 Cloudflare 共用现有 D1 资料，部署方法见 **[VERCEL部署.md](./VERCEL部署.md)**。

国内走 Vercel、国外走 Cloudflare 的配置见 **[地区分流.md](./地区分流.md)**。

## 单文件部署

网站和后台都在 `worker.js` 中，无需安装依赖或上传其他文件。

1. 打开 Cloudflare 的 **Workers & Pages**，选择你创建的 Worker，点击 **Edit code / 编辑代码**。
2. 将 `worker.js` 全部内容粘贴进去，替换原来的代码，然后部署。
3. 在 Cloudflare 的 **Storage & databases → D1** 创建一个数据库，名称填写 **`class-directory-62`**。名称只能使用小写字母、数字、下划线和短横线，不能包含中文、空格或大写字母。
4. 回到 Worker 的 **Bindings / 绑定**，添加 **D1 database**，变量名填写 **`DB`**，选择刚创建的数据库。不要绑定为 KV；这里使用的是 D1。
5. 在 Worker 的 **Settings → Variables and Secrets** 添加两个 **Secret / 密钥**：
   - `ADMIN_PASSWORD`：你自己设置的管理员密码。
   - `SESSION_SECRET`：你自己生成的随机字符串，至少 32 个字符，用于登录会话签名。
6. 保存并重新部署，打开该 Worker 的 `workers.dev` 网址。

数据库名称是 `class-directory-62`，绑定变量名是 `DB`，这两个字段不同。数据表会自动创建，不需要另执行 SQL。资料和头像保存到 D1，刷新页面或重新部署不会清空。

## 使用

- 所有人无需登录即可查看通讯录，支持按姓名、学号、微信号搜索和复制微信号。
- 点击右上角 **管理后台** 或直接打开 **`/admin`**，账号固定为 **`admin`**，密码为你设置的 `ADMIN_PASSWORD`。只有 `/admin` 页面显示添加、编辑、删除功能。
- 每位同学拥有独立资料页，链接格式为 **`/students/唯一编号`**。点击姓名或 **查看个人资料** 打开，可以复制链接分享，无需登录。修改姓名、学号或微信号不会改变该链接；删除后链接返回资料不存在。
- 后台填写姓名、学号、微信号，并选择微信头像，然后点击 **添加同学**。
- 头像支持 JPG、PNG、WebP，浏览器会裁剪为正方形并压缩后保存。
- 管理员可以编辑或删除已有资料，同一学号不能重复添加。
- 登录有效期为 24 小时；同一来源 15 分钟内最多尝试登录 8 次。

页面标题为 **6（2）班通讯录**，小字为 **made by gpt 6.1 sol**。

## 更新现有 Worker

用最新版 `worker.js` 替换编辑器中的全部代码，保存并部署。继续使用原来的 `DB` 绑定和数据库，已有同学资料会保留，并自动获得独立链接。

部署前需要配置 **两个密钥**，两者用途不同：`ADMIN_PASSWORD` 是 admin 的登录密码；`SESSION_SECRET` 是至少 32 字符的随机会话签名密钥。缺少任意一个都无法登录。它们都在 **Settings → Variables and Secrets** 添加，类型选 **Secret**，名称区分大小写。

联系方式公开展示。添加同学资料前，请取得本人同意。
