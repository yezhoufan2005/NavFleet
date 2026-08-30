<script setup lang="ts">
/**
 * 管理 — an aggregate section, so it gets a real landing page.
 *
 * Constraint C2: clicking an aggregate must not drop you into whichever child
 * happens to be first. This page is the map of the section, and it also carries the
 * honest news that most of it does not exist yet.
 *
 * That "does not exist yet" is the biggest gap the second audit surfaced. v1.0.0's
 * RBAC is nominal — the three roles have identical permissions in a production
 * deployment, there is no user-management API of any kind, and adding a second
 * person means writing to the database by hand. Phase 15 is where that changes;
 * until then, listing the areas is more useful than pretending.
 */
import PageHeader from "@/components/PageHeader.vue";

const AREAS: readonly { label: string; plan: string; intent: string }[] = [
  { label: "用户", plan: "15B", intent: "增删改、改密码、启停用" },
  { label: "用户组", plan: "15C", intent: "组与权限矩阵" },
  { label: "审计", plan: "15D", intent: "谁在什么时候做了什么" },
  { label: "设备接入", plan: "16C", intent: "接入凭据与主题" },
  { label: "场景", plan: "13F", intent: "场景与地图资源" },
  {
    label: "报码字典",
    plan: "16C",
    intent: "报码到文案的映射，目前根本不存在",
  },
  { label: "系统状态", plan: "13F", intent: "连接诊断，从旧设置页搬来" },
];
</script>

<template>
  <PageHeader
    title="管理"
    lede="用户、接入、字典与系统状态。这一区大部分尚未实现。"
  >
    <ul class="grid gap-3 md:grid-cols-2 3xl:grid-cols-3">
      <li
        v-for="area in AREAS"
        :key="area.label"
        class="flex flex-col gap-1 rounded-md border border-dashed border-border-strong bg-surface-raised p-4"
      >
        <span class="flex items-baseline gap-2">
          <span class="text-md font-semibold text-ink">{{ area.label }}</span>
          <span class="font-mono text-2xs text-ink-subtle"
            >PR {{ area.plan }}</span
          >
        </span>
        <span class="text-sm text-ink-muted">{{ area.intent }}</span>
      </li>
    </ul>
  </PageHeader>
</template>
