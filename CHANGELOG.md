# Changelog

## [1.1.0](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.3...v1.1.0) (2026-09-09)


### Features

* **console:** 接上后端一直在广播、而没人消费的那四种事件 ([3986f64](https://github.com/yezhoufan2005/NavFleet/commit/3986f64d3b45b340e75a49cbfd6f6d9dfa8207fa))
* **deploy:** 补 Alertmanager，告警从此有接收端；并整理 ROADMAP 的现状口径 ([f486658](https://github.com/yezhoufan2005/NavFleet/commit/f486658536e811377e58a6c36fcc5d9d5c66fa38))


### Bug Fixes

* **backend:** history 的 limit 上界降到实际值，不再对外承诺 500 给不出的 4500 ([d4626d0](https://github.com/yezhoufan2005/NavFleet/commit/d4626d0abf4b3563b4153d19396c7ad241ab50a7))
* **backend:** OpenAPI 文档与实际路由对齐 —— 四条路径、两种全局响应、三个字段、一处 3.1 违规 ([5ff9905](https://github.com/yezhoufan2005/NavFleet/commit/5ff9905c33054f16c67309773f581a7a7281c28f))
* **ci:** 新门禁第一次进 CI 就被自己绊倒 —— 挂载点检查要豁免刻意不入库的路径 ([2ecf6a5](https://github.com/yezhoufan2005/NavFleet/commit/2ecf6a54de77292731d2ffdc51e712c029ded932))
* **console:** 一个「未用的 prop」原来是没接上的修复；顺带删掉与只读定位相悖的 danger ([07afa83](https://github.com/yezhoufan2005/NavFleet/commit/07afa83e8beb122bd54a7f484fb2ffbf6af4693e))
* **console:** 系统状态页的「再次检查」改成「重新检查」，与场景页一致 ([a59edfa](https://github.com/yezhoufan2005/NavFleet/commit/a59edfa2014e6158b2931e6da82768a20abaa3fe))
* **frontend:** 冻结的控制台把历史页 limit 从 1000 降到 500 ([3341442](https://github.com/yezhoufan2005/NavFleet/commit/33414423712460a3fb0822af0a3af6f9ea527857))
* **scripts:** --help 的 sed 范围写错，末尾多印四行代码 ([f04b077](https://github.com/yezhoufan2005/NavFleet/commit/f04b077a3812dd0a0f2f303c0fc9d15364e84128))
* **shared:** MapProfile 的词表改成真的，并删掉一个只是第二个名字的类型 ([bba0e9d](https://github.com/yezhoufan2005/NavFleet/commit/bba0e9df011cc0e77009a50964bf34505ad8e29d))
* 全仓审计第一批 —— 五个真 bug，两个 normalize 实现的一致性 ([90d1f95](https://github.com/yezhoufan2005/NavFleet/commit/90d1f95000ea5fe17fad113f76f5976fc315eacf))

## [1.0.3](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.2...v1.0.3) (2026-09-02)


### Bug Fixes

* **backend:** P0-b / P0-d —— 摄入队列封顶，设备内存加准入与淘汰 ([29da46d](https://github.com/yezhoufan2005/NavFleet/commit/29da46d5cbbec3b4e2c6bb418bc829ff964aaf6f))
* **backend:** P0-c / P0-e / 优雅关闭 —— 三处会丢数据的路径 ([980dcd5](https://github.com/yezhoufan2005/NavFleet/commit/980dcd5e167d4f2701a5195877edb37455825113))
* **backend:** 那条测试里的 NUL 是我写坏的，不是我想测的 ([482a47e](https://github.com/yezhoufan2005/NavFleet/commit/482a47e6a1aaa1849a929ef589bca6ce7eac8efc))
* **fleet-core:** 两处把「缺失」当成值的回退（parity 9.1 / 9.19） ([474e130](https://github.com/yezhoufan2005/NavFleet/commit/474e130a1f3823b4f352a22ff92531784f61a4a4))
* **fleet-core:** 删掉 dataDefaults 的两个永久空常量（parity 8.7） ([1b04514](https://github.com/yezhoufan2005/NavFleet/commit/1b0451407afaa77571af4e9e7e0472beebb4ed77))

## [1.0.2](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.1...v1.0.2) (2026-08-30)


### Features

* **console:** scaffold frontend-next and retire the theme risk ([2e0a499](https://github.com/yezhoufan2005/NavFleet/commit/2e0a499c39584d045e92a5f29cd68bda006af7e9))
* **fleet-core:** extract the logic both frontends will share ([c485a3d](https://github.com/yezhoufan2005/NavFleet/commit/c485a3d063ec79c7249cd28badddb7de6e3f443e))


### Bug Fixes

* **a11y:** stop the nav pill animating into an unreadable colour pair ([69ccfc4](https://github.com/yezhoufan2005/NavFleet/commit/69ccfc48ec02f3aa5596e8a792f79666dfc58a21))


### Miscellaneous Chores

* **release:** put the version back to 1.0.1 and pin the next release to 1.0.2 ([a0b9d19](https://github.com/yezhoufan2005/NavFleet/commit/a0b9d19710b8b7e3d27b9446961f71404642d95b))

## [1.0.1](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.0...v1.0.1) (2026-08-29)

### Bug Fixes

- **ws:** contain connection errors instead of taking the process down ([82bbcc6](https://github.com/yezhoufan2005/NavFleet/commit/82bbcc6729148c7656219478094192ec25c56d1a))

## 1.0.0 (2026-08-29)

首个基准版本。NavFleet 是一套面向 AGV / 巡检车 / 无人搬运车的**只读**实时监控平台：
MQTT 接入 → 字段归一化与告警派生 → 内存快照 → MongoDB 持久化 → REST + WebSocket →
Vue 3 多页工作台。

本版本的能力清单、部署编排与已知边界见 [README](README.md) 与
[ARCHITECTURE.md](ARCHITECTURE.md)。

1.0 之前的开发过程（Phase 0–10，含每个阶段修掉的具体缺陷与当时的取舍依据）记录在
[docs/roadmap-archive.md](docs/roadmap-archive.md)。那些阶段没有对外发布过可用的构建产物 —— 早期的 0.x tag 与
Release 已移除，镜像发布链路直到本版本才真正打通 —— 所以本变更日志不为它们单列条目，
本版本即第一个对外基准包。
