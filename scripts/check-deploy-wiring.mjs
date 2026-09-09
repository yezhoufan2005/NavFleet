#!/usr/bin/env node
/**
 * 部署接线一致性门禁。
 *
 * 14J 把前端切换成 v3 时引入了几条**跨文件**约束 —— 它们分散在 compose、nginx 与 workflow 里，
 * 各自都是合法文件，只有放在一起看才知道对不对。而 CI 此前完全不看 `deploy/`：改坏其中任何一处
 * 都不会红，只会在下一次真起栈时才发现。
 *
 * 这个脚本就检查那几条。它是纯静态的 —— 不起容器、不需要 Docker，所以能进 CI 的常规 job。
 * 需要真起栈的那一层在 `scripts/verify-stack.sh`（56 条断言），两者互补而不重叠。
 *
 * 用法：node scripts/check-deploy-wiring.mjs
 * 全部通过才返回 0。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY = join(ROOT, "deploy");

let pass = 0;
const failures = [];
const ok = (msg) => {
  pass += 1;
  console.log(`  ✓ ${msg}`);
};
const bad = (msg) => {
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
};

const read = (p) => readFileSync(p, "utf8");

/** compose 文件清单（基础 + 所有叠加）。 */
const composeFiles = readdirSync(DEPLOY)
  .filter((f) => /^docker-compose.*\.ya?ml$/.test(f))
  .sort();

/**
 * 服务名。刻意用正则而不是 YAML 解析器：这个仓库没有 yaml 依赖，而为一个门禁引入一个只在
 * 门禁里用的运行时依赖是本末倒置。顶层 `services:` 下缩进两格的键就是服务名。
 */
const servicesOf = (text) => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "services:");
  if (start < 0) return [];
  const names = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === "" || l.startsWith("#")) continue;
    // 回到顶层缩进就说明 services 块结束了
    if (/^\S/.test(l)) break;
    const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) names.push(m[1]);
  }
  return names;
};

const baseText = read(join(DEPLOY, "docker-compose.yml"));
const baseServices = servicesOf(baseText);

console.log("部署接线检查:\n");

// ---------------------------------------------------------------------------
// 1. nginx 的上游必须是 compose 里存在的服务
// ---------------------------------------------------------------------------
// `proxy_pass http://backend:3000/` 里的 `backend` 必须是一个服务名，否则 nginx 在启动时就会
// 以 `host not found in upstream` 失败 —— 而那要等到真起栈才看得到。
for (const conf of [
  "nginx/locations.conf",
  "nginx/default.conf",
  "nginx/tls.conf",
]) {
  const p = join(DEPLOY, conf);
  if (!existsSync(p)) {
    bad(`${conf} 不存在`);
    continue;
  }
  const upstreams = [
    ...new Set(
      [...read(p).matchAll(/proxy_pass\s+https?:\/\/([A-Za-z0-9_-]+)/g)].map(
        (m) => m[1],
      ),
    ),
  ];
  for (const host of upstreams) {
    if (baseServices.includes(host))
      ok(`${conf} 的上游 ${host} 是 compose 服务`);
    else
      bad(
        `${conf} 的上游 ${host} 不是 compose 服务（现有：${baseServices.join(", ")}）`,
      );
  }
}

// ---------------------------------------------------------------------------
// 2. 叠加文件只能覆盖基础文件里已有的服务
// ---------------------------------------------------------------------------
// 这一条针对回滚 overlay：compose 的合并语义是 mapping 逐键合并、list 追加，所以 overlay
// **删不掉** `depends_on` 里的条目。用一个新服务名去回滚，会把两套镜像一起拉起来，而不是替换。
// 监控与备份叠加是**刻意新增**服务的，所以它们在白名单里。
const ADDITIVE = new Set([
  "docker-compose.monitoring.yml",
  "docker-compose.backup.yml",
]);
for (const f of composeFiles) {
  if (f === "docker-compose.yml") continue;
  const svcs = servicesOf(read(join(DEPLOY, f)));
  if (ADDITIVE.has(f)) {
    ok(`${f} 是新增型叠加（${svcs.join(", ")}），跳过复用检查`);
    continue;
  }
  for (const s of svcs) {
    if (baseServices.includes(s)) ok(`${f} 覆盖的服务 ${s} 在基础编排里`);
    else
      bad(
        `${f} 引入了新服务 ${s} —— 覆盖型叠加必须复用基础服务名，否则会同时拉起两套`,
      );
  }
}

// ---------------------------------------------------------------------------
// 3. 所有 dockerfile 路径必须存在（compose 与 publish-images 各一份）
// ---------------------------------------------------------------------------
for (const f of composeFiles) {
  for (const m of read(join(DEPLOY, f)).matchAll(
    /^\s*dockerfile:\s*(\S+)\s*$/gm,
  )) {
    const rel = m[1];
    if (existsSync(join(ROOT, rel))) ok(`${f} 引用的 ${rel} 存在`);
    else bad(`${f} 引用的 dockerfile 不存在：${rel}`);
  }
}
const publish = join(ROOT, ".github/workflows/publish-images.yml");
for (const m of read(publish).matchAll(/^\s*dockerfile:\s*(\S+)\s*$/gm)) {
  const rel = m[1];
  if (existsSync(join(ROOT, rel))) ok(`publish-images 引用的 ${rel} 存在`);
  else bad(`publish-images 引用的 dockerfile 不存在：${rel}`);
}

// ---------------------------------------------------------------------------
// 4. 镜像必须钉版本，不能用浮动 tag
// ---------------------------------------------------------------------------
// `latest` 让「同一份 compose 在两台机器上起出不同的东西」成为可能，而这类差异最难排查。
for (const f of composeFiles) {
  for (const m of read(join(DEPLOY, f)).matchAll(/^\s*image:\s*(\S+)/gm)) {
    const image = m[1];
    if (/:latest$/.test(image) || !image.includes(":"))
      bad(`${f} 的镜像未钉版本：${image}`);
    else ok(`${f} 的镜像已钉版本：${image}`);
  }
}

// ---------------------------------------------------------------------------
// 5. compose 引用的每个变量都要在 .env.example 里出现
// ---------------------------------------------------------------------------
// 少一个的后果分两种：带默认值的静默用默认值，`${VAR:?}` 形式的直接让 `up` 失败。两种都不该
// 靠部署方自己发现 —— `.env.example` 是他们唯一的清单。
const envExample = read(join(DEPLOY, ".env.example"));
const declared = new Set(
  [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
);
const referenced = new Set();
for (const f of composeFiles) {
  for (const m of read(join(DEPLOY, f)).matchAll(/\$\{([A-Z][A-Z0-9_]*)/g))
    referenced.add(m[1]);
}
const undeclared = [...referenced].filter((v) => !declared.has(v)).sort();
if (undeclared.length === 0)
  ok(`compose 引用的 ${referenced.size} 个变量都在 .env.example 里`);
else bad(`.env.example 缺少 compose 引用的变量：${undeclared.join(", ")}`);

// ---------------------------------------------------------------------------
// 6. compose 里以仓库相对路径挂载的文件/目录必须存在
// ---------------------------------------------------------------------------
// 挂一个不存在的路径，docker 会**建一个空目录**给你 —— 比报错更糟，因为服务会带着空配置起来。
//
// 例外必须是「本来就刻意不在仓库里」的那些，而不是「本机恰好有」的那些 —— 这条门禁第一次进 CI
// 就被自己绊倒了：`deploy/nginx/certs/` 在 `.gitignore` 里（私钥不进仓库），所以本机绿、
// CI 的全新 checkout 红。判据用 gitignore 而不是硬编码目录名：以后再有刻意不入库的挂载点，
// 只要它被 ignore 了就自动豁免，而一个**忘记提交**的文件仍然会红。
//
// 两种写法都试：目录不存在时，`git check-ignore deploy/nginx/certs` 返回「未忽略」，而
// `deploy/nginx/certs/`（带尾斜杠）才匹配 `.gitignore` 里的目录模式。这个差别只在目录缺失时
// 才显现 —— 也就是恰好在需要它的那种情况下。
const ignored = (rel) => {
  const target = join("deploy", rel);
  return ["", "/"].some(
    (suffix) =>
      spawnSync("git", ["check-ignore", "-q", target + suffix], { cwd: ROOT })
        .status === 0,
  );
};
for (const f of composeFiles) {
  for (const m of read(join(DEPLOY, f)).matchAll(/^\s*-\s+(\.\/[^:\s]+):/gm)) {
    const rel = m[1];
    // ${VAR} 插值过的路径静态查不了；BACKUP_HOST_PATH 的默认目录允许不存在（首次备份才创建）
    if (rel.includes("$")) continue;
    if (existsSync(join(DEPLOY, rel))) ok(`${f} 挂载的 ${rel} 存在`);
    else if (ignored(rel))
      ok(`${f} 挂载的 ${rel} 刻意不入库（gitignore），跳过`);
    else bad(`${f} 挂载了不存在的路径：${rel}（docker 会静默建一个空目录）`);
  }
}

console.log(`\n通过 ${pass} · 失败 ${failures.length}`);
if (failures.length) {
  console.error("\n部署接线检查未通过：");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
