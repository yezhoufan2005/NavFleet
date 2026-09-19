<script setup lang="ts">
/**
 * 管理 — an aggregate section, so it gets a real landing page.
 *
 * Constraint C2: clicking an aggregate must not drop you into whichever child happens to be
 * first. This page is the map of the section — one card per built admin area.
 *
 * It once also carried dashed "not built yet" placeholders for planned areas (用户组 / 设备
 * 接入). Those were dropped in Phase 18: full RBAC groups are heavy for a read-only intranet
 * console whose three roles are near-identical, and device-access credential management is
 * deployment-side config, not something a read-only console should write. Every card here is
 * therefore a real, navigable area.
 */
import { RouterLink } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";

interface Area {
  label: string;
  plan: string;
  intent: string;
  to: string;
}

const AREAS: readonly Area[] = [
  {
    label: "用户",
    plan: "15E",
    intent: "增删改、改密码、启停用、强制下线与查看会话",
    to: "/admin/users",
  },
  {
    label: "审计",
    plan: "15E",
    intent: "谁在什么时候做了什么",
    to: "/admin/audit",
  },
  {
    label: "场景",
    plan: "13F",
    intent: "场景与地图资源，并检查资源是否真的取得到",
    to: "/admin/scenes",
  },
  {
    label: "报码字典",
    plan: "16C",
    intent: "报码到含义/等级/处理建议的映射，可导入部署侧码表覆盖内置表",
    to: "/admin/codebook",
  },
  {
    label: "外发",
    plan: "16D",
    intent:
      "告警外发渠道与发送记录（webhook / 企业微信 / 钉钉 / 邮件），盘上 notify.json 配置、这里只读",
    to: "/admin/notify",
  },
  {
    label: "系统状态",
    plan: "13F",
    intent: "链路诊断与本浏览器留存的数据",
    to: "/admin/system",
  },
];

const CARD_BASE =
  "flex h-full flex-col gap-1 rounded-md bg-surface-raised p-4 transition-colors duration-150 ease-standard";
</script>

<template>
  <PageHeader title="管理">
    <ul class="grid list-none gap-3 p-0 md:grid-cols-2 3xl:grid-cols-3">
      <li v-for="area in AREAS" :key="area.label">
        <!-- A link, because it is navigation — so ⌘-click and "copy link address"
             keep working. -->
        <RouterLink
          :to="area.to"
          :class="[
            CARD_BASE,
            'border border-border hover:border-border-strong hover:bg-surface-sunken',
          ]"
        >
          <span class="flex items-baseline gap-2">
            <span class="text-md font-semibold text-ink">{{ area.label }}</span>
            <span class="ml-auto font-mono text-2xs text-brand-ink"
              >已就绪</span
            >
          </span>
          <span class="text-sm text-ink-muted">{{ area.intent }}</span>
        </RouterLink>
      </li>
    </ul>
  </PageHeader>
</template>
