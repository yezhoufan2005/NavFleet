#!/usr/bin/env node
/**
 * 部署接线一致性门禁。
 *
 * 把前端切换成 v3 时引入了几条**跨文件**约束 —— 它们分散在 compose、nginx 与 workflow 里，
 * 各自都是合法文件，只有放在一起看才知道对不对。而 CI 此前完全不看 `deploy/`：改坏其中任何一处
 * 都不会红，只会在下一次真起栈时才发现。
 *
 * 这个脚本就检查那几条。它是纯静态的 —— 不起容器、不需要 Docker，所以能进 CI 的常规 job。
 * 需要真起栈的那一层在 `scripts/verify-stack.sh`（起栈后逐条断言），两者互补而不重叠。
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
// 监控、备份与演示叠加是**刻意新增**服务的，所以它们在白名单里。
const ADDITIVE = new Set([
  "docker-compose.monitoring.yml",
  "docker-compose.backup.yml",
  "docker-compose.demo.yml",
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

// ---------------------------------------------------------------------------
// 7. locations.conf 里 include 的每个文件都必须被挂进容器
// ---------------------------------------------------------------------------
// `include /etc/nginx/security-headers.conf;` 引用的文件若没有对应的 volume 挂载，nginx
// 启动时直接 `open() ... failed`——又是要等真起栈才看得到的那类。判据：locations.conf /
// default.conf / tls.conf 里出现的每个 /etc/nginx/*.conf include 目标，都要有某个 compose
// 文件把一个文件挂到该容器路径。（locations.conf 自身由 default/tls.conf include，已在别处挂载。）
const mountTargets = new Set();
for (const f of composeFiles) {
  for (const m of read(join(DEPLOY, f)).matchAll(
    /:\s*(\/etc\/nginx\/[A-Za-z0-9_.-]+):ro\b/g,
  )) {
    mountTargets.add(m[1]);
  }
}
const includeTargets = new Set();
for (const conf of [
  "nginx/locations.conf",
  "nginx/default.conf",
  "nginx/tls.conf",
]) {
  const p = join(DEPLOY, conf);
  if (!existsSync(p)) continue;
  for (const m of read(p).matchAll(/^\s*include\s+(\/etc\/nginx\/\S+?);/gm)) {
    includeTargets.add(m[1]);
  }
}
for (const target of includeTargets) {
  if (mountTargets.has(target))
    ok(`nginx include 的 ${target} 有对应的 volume 挂载`);
  else
    bad(
      `nginx include 了 ${target} 但没有任何 compose 把文件挂到该路径（nginx 启动会 open() 失败）`,
    );
}

// 8. 边缘的请求体上限与超时必须作用在控制台**实际调用的路径**上，并与后端一致。nginx 默认只放行
//    1 MB、读超时 60 s，比后端的 JSON（2mb）、底图上传（RAW_LIMIT）与报表查询超时都小。
//    路径取自 fleet-core 的 fleetApi.ts，按 nginx 的规则选块（正则 location 按出现顺序先匹配者
//    胜，否则取最长前缀）：此前专用块只写了 /api/scenes/ 与 /api/reports/，控制台走的
//    /api/v1/… 全部落进 /api/ 块，这条检查却只按块的表头取值，所以一直是绿的。
{
  const locations = read(join(DEPLOY, "nginx/locations.conf"));
  const toBytes = (v) => {
    const m = String(v)
      .trim()
      .toLowerCase()
      .match(/^(\d+)\s*([km]?)b?$/);
    if (!m) return Number.NaN;
    return (
      Number(m[1]) * (m[2] === "m" ? 1024 * 1024 : m[2] === "k" ? 1024 : 1)
    );
  };
  const toSeconds = (v) => {
    const m = String(v ?? "").match(/^(\d+)(ms|s|m)?$/);
    if (!m) return Number.NaN;
    const n = Number(m[1]);
    return m[2] === "ms" ? n / 1000 : m[2] === "m" ? n * 60 : n;
  };
  // 顶层 location 块：修饰符、匹配串、块体。
  const blocks = [
    ...locations.matchAll(
      /^location\s+(=|~\*?|\^~)?\s*(\S+)\s*\{([\s\S]*?)^\}/gm,
    ),
  ].map((m) => ({ modifier: m[1] ?? "", match: m[2], body: m[3] }));
  const blockFor = (path) => {
    const exact = blocks.find((b) => b.modifier === "=" && b.match === path);
    if (exact) return exact;
    const prefixes = blocks
      .filter(
        (b) =>
          (b.modifier === "" || b.modifier === "^~") &&
          path.startsWith(b.match),
      )
      .sort((a, b) => b.match.length - a.match.length);
    if (prefixes[0]?.modifier === "^~") return prefixes[0];
    const regex = blocks.find(
      (b) =>
        b.modifier.startsWith("~") &&
        new RegExp(b.match, b.modifier === "~*" ? "i" : "").test(path),
    );
    return regex ?? prefixes[0] ?? null;
  };
  const directive = (block, name) =>
    block?.body.match(new RegExp(`^\\s*${name}\\s+(\\S+);`, "m"))?.[1] ?? null;

  const fleetApi = read(join(ROOT, "packages/fleet-core/src/fleetApi.ts"));
  const assetPath =
    fleetApi
      .match(/`(\/api\/[^`]*\/scenes\/)\$\{[^}]+\}(\/asset\/)\$\{[^}]+\}`/)
      ?.slice(1)
      .join("demo-scene") + "backdrop";
  const reportPath = fleetApi.match(
    /`(\/api\/[^`$]*\/reports\/availability)/,
  )?.[1];
  const jsonPath = fleetApi.match(/"(\/api\/[^"]*\/codebook)"/)?.[1];

  const scenesSrc = read(join(ROOT, "backend/src/routes/scenes.ts"));
  const rawLimit = scenesSrc.match(/const RAW_LIMIT = "([^"]+)"/)?.[1];
  const appSrc = read(join(ROOT, "backend/src/app.ts"));
  const jsonLimit = appSrc.match(
    /express\.json\(\{ limit: "([^"]+)" \}\)/,
  )?.[1];
  const configSrc = read(join(ROOT, "backend/src/config.ts"));
  const reportTimeoutMs = Number(
    configSrc
      .match(/REPORT_QUERY_TIMEOUT_MS:\s*envInt\(([\d_]+)/)?.[1]
      ?.replace(/_/g, ""),
  );

  const limits = [
    [assetPath, rawLimit, "底图上传（RAW_LIMIT）"],
    [jsonPath, jsonLimit, "JSON 请求体（express.json）"],
    [reportPath, jsonLimit, "报表接口的 JSON 请求体"],
  ];
  for (const [path, backend, label] of limits) {
    if (!path || path.includes("undefined")) {
      bad(`从 fleetApi.ts 读不到 ${label} 用的请求路径`);
      continue;
    }
    const block = blockFor(path);
    const edge = directive(block, "client_max_body_size");
    if (!backend) bad(`读不到后端的 ${label} 上限`);
    else if (!block) bad(`nginx 没有 location 能匹配 ${path}`);
    else if (!edge)
      bad(
        `${path} 落进的 nginx 块（${block.match}）没设 client_max_body_size（默认 1 MB < 后端 ${backend}）`,
      );
    else if (toBytes(edge) !== toBytes(backend))
      bad(
        `${path} 落进的 nginx 块（${block.match}）上限 ${edge} 与后端 ${label} ${backend} 不一致`,
      );
    else ok(`${path} 的 nginx 上限与后端 ${label} 一致（${backend}）`);
  }

  if (!reportPath || !Number.isFinite(reportTimeoutMs)) {
    bad("读不到报表请求路径或后端 REPORT_QUERY_TIMEOUT_MS 默认值");
  } else {
    const block = blockFor(reportPath);
    const edge = toSeconds(directive(block, "proxy_read_timeout") ?? "60s");
    if (edge * 1000 <= reportTimeoutMs)
      bad(
        `${reportPath} 落进的 nginx 块读超时 ${edge}s 不长于后端报表查询超时 ${reportTimeoutMs / 1000}s，慢报表会在边缘 504`,
      );
    else
      ok(
        `${reportPath} 的 nginx 读超时 ${edge}s 长于后端报表查询超时 ${reportTimeoutMs / 1000}s`,
      );
  }
}

// 9. 后端读取、且 .env.example 写成可调项的变量，必须真的传进 backend 容器。compose 没有
//    env_file，只把 environment 块里列出的键交给容器：漏一个，部署方改了也不生效，也不报错。
//    键集取 backend/src/config.ts 的 env schema（.env.example 里还有 nginx、grafana、备份等
//    其他服务的键，不能整份拿来比）。
{
  const configSrc = read(join(ROOT, "backend/src/config.ts"));
  const schemaStart = configSrc.indexOf("const configSchema = z.object({");
  const schema = configSrc.slice(
    schemaStart,
    configSrc.indexOf("\n});", schemaStart),
  );
  const backendKeys = [...schema.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map(
    (m) => m[1],
  );
  const compose = read(join(DEPLOY, "docker-compose.yml"));
  const serviceAt = compose.indexOf("\n  backend:\n");
  const envAt = compose.indexOf("\n    environment:\n", serviceAt);
  const envEnd = compose.slice(envAt + 1).search(/\n {4}[a-z_]+:/);
  const envBlock = compose.slice(
    envAt,
    envEnd < 0 ? undefined : envAt + 1 + envEnd,
  );
  const passed = new Set(
    [...envBlock.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]),
  );
  const documented = new Set(
    [...envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
  );
  if (serviceAt < 0 || envAt < 0 || backendKeys.length === 0) {
    bad("读不到 backend 的 env schema 或 compose 的 backend environment 块");
  } else {
    const missing = backendKeys.filter(
      (k) => documented.has(k) && !passed.has(k),
    );
    if (missing.length === 0)
      ok(
        `.env.example 里的 ${backendKeys.filter((k) => documented.has(k)).length} 个后端变量都传进了 backend 容器`,
      );
    else
      bad(
        `.env.example 写了、compose 却没传给 backend 的变量：${missing.join(", ")}`,
      );
  }
}

console.log(`\n通过 ${pass} · 失败 ${failures.length}`);
if (failures.length) {
  console.error("\n部署接线检查未通过：");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
