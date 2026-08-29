# Changelog

## 1.0.0 (2026-08-29)

首个基准版本。NavFleet 是一套面向 AGV / 巡检车 / 无人搬运车的**只读**实时监控平台：
MQTT 接入 → 字段归一化与告警派生 → 内存快照 → MongoDB 持久化 → REST + WebSocket →
Vue 3 多页工作台。

本版本的能力清单、部署编排与已知边界见 [README](README.md) 与
[ARCHITECTURE.md](ARCHITECTURE.md)。

1.0 之前的开发过程（Phase 0–10，含每个阶段修掉的具体缺陷与当时的取舍依据）记录在
[ROADMAP.md](ROADMAP.md)。那些阶段没有对外发布过可用的构建产物 —— 早期的 0.x tag 与
Release 已移除，镜像发布链路直到本版本才真正打通 —— 所以本变更日志不为它们单列条目，
本版本即第一个对外基准包。
