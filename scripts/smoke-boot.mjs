/**
 * 启动冒烟：按线上同样的方式拉起 web profile，检查本插件是否真的被宿主认领。
 *
 * 用法（在 DSH 已停的情况下跑）：
 *   node scripts/smoke-boot.mjs            # 用包名 dsh-purge 之前的真实状态
 *   node scripts/smoke-boot.mjs --virtual  # 模拟「宿主能按 name 解析 dsh-purge」的部署
 *
 * 它会：
 *   1. 起一个临时端口（不碰 3080），跑 profile 里真实的补丁层；
 *   2. 等待宿主就绪，然后打印：tools / commands / redteam 服务有没有；
 *   3. 拉一次 GET /，看本插件的 client bundle 有没有进组合图、能不能取到；
 *   4. 退出码 0 = 全部就绪。
 *
 * 0.2.2-rc.1 起插件行由 bundle 补丁层按 name 解析：profile 里 link 进来的包如果只剩一条
 * 软链接，宿主解析不到 dsh-purge，行会一直 pending（只打一行 "patch: entry not found"）。
 * 本脚本就是为了在发布前把这个坑量出来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profile = process.env.DSH_PROFILE || 'web';
const PORT = Number(process.env.DSH_PURGE_SMOKE_PORT || 0) || 4630 + Math.floor(Math.random() * 20);

// 模拟「宿主按 name 能找到 dsh-purge」：只在 --virtual 时挂。
if (process.argv.includes('--virtual')) {
  const map = {
    'dsh-purge': path.join(root, 'lib/index.js'),
    'dsh-purge/redteam': path.join(root, 'lib/redteam/index.js'),
    'dsh-purge/redteam/store': path.join(root, 'lib/redteam/store.js'),
    'dsh-purge/redteam/ui': path.join(root, 'lib/redteam/ui.js'),
  };
  const before = process.env.DSH_PURGE_SMOKE_HOOKS;
  registerHooks({
    resolve(specifier, context, next) {
      if (map[specifier]) return { url: pathToFileURL(map[specifier]).href, shortCircuit: true };
      return next(specifier, context);
    },
  });
  process.env.DSH_PURGE_SMOKE_HOOKS = before || '1';
}

const overlay = path.join(os.tmpdir(), `dsh-purge-smoke-${process.pid}.yml`);
fs.writeFileSync(overlay, `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ${PORT}\n`);

const say = (ok, label, extra = '') => console.log(`${ok ? '✓' : '✗'} ${label}${extra ? `: ${extra}` : ''}`);

// 从 profile 里解析 dsh 自身，脚本放在插件仓库里也能跑；profile 没有时退回全局安装。
const { createRequire } = await import("node:module");
const candidates = [path.join(home, "profiles", profile), path.dirname(path.dirname(root)), "/opt/dsh"];
const hostPkg = (() => {
  for (const dir of candidates) {
    try {
      const r = createRequire(path.join(dir, "package.json")).resolve("@deepseek-ai/dsh/package.json");
      return r;
    } catch { /* 换下一个 */ }
  }
  return null;
})();
if (!hostPkg) throw new Error("smoke-boot: 找不到 @deepseek-ai/dsh，先设置 DSH_HOME 或全局安装");
const hostRoot = path.dirname(hostPkg);
const { runProfile } = await import(pathToFileURL(path.join(hostRoot, "lib/profile-boot.js")).href);
const { loadLayeredEnv } = await import(pathToFileURL(createRequire(hostPkg).resolve("@deepseek-ai/dsh-app-boot")).href);

const result = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile,
  args: [],
  patchFiles: [overlay],
});
const ctx = result.ctx;
const has = (name) => {
  try { return ctx.get(name) !== undefined; } catch { return false; }
};

let ok = true;
const tools = ctx.get('tools');
const wantTools = ['purge_status', 'purge_apply', 'purge_revert'];
for (const t of wantTools) {
  const present = !!tools?.get?.(t);
  ok &&= present;
  say(present, `tool ${t}`);
}
let commands = [];
try { commands = (ctx.get('commands')?.list?.() || []).map((c) => c.name); } catch { /* ignore */ }
for (const c of ['purge', 'rules', 'skills', 'rewind']) {
  const present = commands.includes(c);
  ok &&= present;
  say(present, `command /${c}`);
}
for (const s of ['redteam', 'redteamMode']) {
  const present = has(s);
  ok &&= present;
  say(present, `service ${s}`);
}

// 提示词组装：0.2.2-rc.1 只注册 provider / model 两个变量，任何段留着 {{cwd}} 都会抛错。
try {
  const sp = ctx.get("systemPrompt");
  const asm = await sp.assemble({});
  const statics = asm.sections.filter((sec) => sec.interpolate !== false && typeof sec.text === "string");
  const leaks = statics.filter((sec) => /\{\{\w+\}\}/.test(sec.text));
  const good = leaks.length === 0;
  ok &&= good;
  say(good, "prompt assembly", good ? `${asm.sections.length} sections, vars ${Object.keys(asm.variables).join(",")}` : `未注册变量留在 ${leaks.map((sec) => sec.name).join(",")}`);
} catch (e) {
  ok = false;
  say(false, "prompt assembly", String(e && e.message ? e.message : e));
}

// client bundle：组合图里有 dsh-purge/client.js，且能在 /plugins 下取到。
// 有的启动器（dsh-app）会在 webserver 前面挂一层路由守卫，POST 一律 401/405；
// 这里模拟浏览器先带 token 换 cookie，再取页面和 bundle。
try {
  const http = await import("node:http");
  const web = ctx.get("webServer");
  const origin = `http://127.0.0.1:${web.port}`;
  const cookieJar = [];
  const call = (pathname, method = "GET", headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(origin + pathname, { method }, (res) => {
      const chunks = [];
      for (const c of res.headers["set-cookie"] ?? []) cookieJar.push(c.split(";")[0]);
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: () => Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (cookieJar.length && !headers.cookie) headers.cookie = cookieJar.join("; ");
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.end();
  });
  let html = "";
  // 1) 登录态：有守卫时必须先访问带 token 的地址换 cookie。
  //    dsh-app 这类启动器会带浏览器 token，用宿主的 authenticatedUrl 拿同一个地址。
  const connection = ctx.get("connection");
  const tokenUrl = connection?.authenticatedUrl ? connection.authenticatedUrl(origin) : "";
  if (tokenUrl) {
    const u = new URL(tokenUrl);
    await call(u.pathname + u.search).catch(() => {});
  }
  const first = await call("/");
  html = first.text();
  if (first.status === 401 || first.status === 403 || html === "") {
    say(false, "client bundle in boot graph", `index ${first.status}（有路由守卫，需要带 token 的 DSH_WEB_URL 再量一次）`);
    throw Object.assign(new Error("index guarded"), { reported: true });
  }
  const combos = [...html.matchAll(/plugins\/\?\?([^&"]*)&(?:amp;)?rev=(\w+)/g)];
  const purge = combos.find((m) => m[1].split(",").includes("dsh-purge/client.js"));
  ok &&= !!purge;
  say(!!purge, "client bundle in boot graph");
  if (purge) {
    const res = await call(`/plugins/??${purge[1]}&rev=${purge[2]}`);
    const body = res.text();
    const good = res.status === 200 && body.includes("settings.dsh-purge");
    ok &&= good;
    say(good, "client bundle served", `${res.status} ${body.length}B`);
  }
} catch (e) {
  ok = false;
  if (!e?.reported) say(false, "client bundle check", String(e && e.message ? e.message : e));
}

fs.rmSync(overlay, { force: true });
console.log(ok ? '\nSMOKE OK' : '\nSMOKE FAILED');
await result.shutdown.shutdown(ok ? 0 : 1);
