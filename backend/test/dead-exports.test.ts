import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * **跨模块契约对象的每个成员都必须有读者。**
 *
 * 这是 console 侧 `frontend-next/test/dead-exports.test.ts` 的后端对应物 —— 但**故意小得多**，
 * 而它为什么小，比它检查什么更值得读。
 *
 * ## 第一版是「每个 export 都要有非测试消费者」，那是错的
 *
 * 照抄 console 的口径跑出来 **25 条**，几乎全是误报：`MetricsDeps` / `MqttDeps` /
 * `OpsRouterDeps` 这类只用来给工厂函数的参数命名的接口（调用方传对象字面量，名字自然不会
 * 在别处出现）、`backoffDelayMs` / `unrefTimerScheduler` / `MONGO_UP_EVENTS` 这类**刻意导出
 * 供单测直接验纯逻辑**的内部件。
 *
 * 两个代码库的性质不同：console 的导出面朝 UI，一个没人调的 `cycleTheme` 意味着一个没造出来的
 * 控件（那份文件的注释举了四层这样的例子）；后端的导出面朝**可测性**，为了不通过整个 app 就能
 * 测一个退避算法而导出它，是设计而不是遗漏。
 *
 * **一个首次运行就需要 25 条豁免的门禁不是门禁，是形式。** 所以那一版删掉了。
 *
 * ## 留下的这一条，针对 14O 真正查出来的东西
 *
 * 14O 那批死代码里唯一有实际代价的是 `Metrics.registry`：一个**接口成员**，全仓零读者，而把它
 * 暴露出去恰好否掉了它上面那段注释在论证的隔离（「刻意不用 prom-client 全局 registry」，然后
 * 把整个 registry 作为公开字段递出去，任何消费者都能往里注册）。
 *
 * 接口成员比模块导出更容易死掉，原因很具体：**删掉一个成员不会让任何 import 报错**，所以它
 * 不会被任何现有门禁碰到，也不会在 code review 里显眼。
 *
 * 只查 `Metrics` 与 `AppDeps` 这两个**装配后端时跨模块传递的契约对象**。领域类型
 * （`DeviceSnapshot` 等）不查：它们描述的是线上数据的形状，一个字段没有读者是产品待办
 * （ROADMAP 的「象限 B：已采集未利用」），不是死代码。
 */

const SRC = resolve(__dirname, "../src");

const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

/**
 * 注释先剥掉。一个只出现在注释里的名字不是读者 —— 它是「关于某个东西的说明」，而那个东西
 * 可能已经不在了。
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/** 这两个接口是「怎么装配一个后端」的契约，成员死掉的代价最高。 */
const CONTRACTS = ["Metrics", "AppDeps"] as const;

describe("跨模块契约对象没有死成员", () => {
  const bodies = new Map(
    tsFiles(SRC).map((path) => [relative(SRC, path), stripComments(readFileSync(path, "utf8"))]),
  );

  it.each(CONTRACTS)("%s 的每个成员都有读者", (iface) => {
    const dead: string[] = [];
    for (const [file, body] of bodies) {
      const block = body.match(new RegExp(`export interface ${iface} \\{([^}]*)\\}`));
      if (!block) continue;
      const members = [...block[1]!.matchAll(/^\s*([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]!);
      expect(members.length).toBeGreaterThan(0);
      for (const member of members) {
        // 读者的两种形态：属性访问（`metrics.render`）或解构/构造时按名出现
        // （`{ store, persistence }`）。定义它的那个文件本身不算。
        const pattern = new RegExp(`\\.\\s*${member}\\b|\\b${member}\\s*[,:}]`);
        const hasReader = [...bodies]
          .filter(([other]) => other !== file)
          .some(([, other]) => pattern.test(other));
        if (!hasReader) dead.push(`${file} → ${iface}.${member}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("门禁自身的前提：只扫 src/，不把 test/ 当读者", () => {
    // 如果哪天有人把 test/ 也塞进 `bodies`，这个门禁会静默失效 —— 一个只被测试引用的死成员
    // 会因为「测试在用」而通过。
    expect([...bodies.keys()].every((f) => !f.startsWith(".."))).toBe(true);
    expect(bodies.size).toBeGreaterThan(20);
  });
});
