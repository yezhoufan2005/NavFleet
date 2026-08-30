# Changelog

## [1.1.0](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.1...v1.1.0) (2026-08-30)


### Features

* **console:** scaffold frontend-next and retire the theme risk ([2e0a499](https://github.com/yezhoufan2005/NavFleet/commit/2e0a499c39584d045e92a5f29cd68bda006af7e9))
* **fleet-core:** extract the logic both frontends will share ([c485a3d](https://github.com/yezhoufan2005/NavFleet/commit/c485a3d063ec79c7249cd28badddb7de6e3f443e))


### Bug Fixes

* **a11y:** stop the nav pill animating into an unreadable colour pair ([69ccfc4](https://github.com/yezhoufan2005/NavFleet/commit/69ccfc48ec02f3aa5596e8a792f79666dfc58a21))

## [1.0.1](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.0...v1.0.1) (2026-08-29)


### Bug Fixes

* **ws:** contain connection errors instead of taking the process down ([82bbcc6](https://github.com/yezhoufan2005/NavFleet/commit/82bbcc6729148c7656219478094192ec25c56d1a))

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
