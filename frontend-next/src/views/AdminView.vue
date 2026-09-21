<script setup lang="ts">
/**
 * 管理 — an aggregate section, so it gets a real landing page.
 *
 * Constraint C2: clicking an aggregate must not drop you into whichever child happens to be
 * first. This page is the map of the section — one card per built admin area.
 *
 * It once also carried dashed "not built yet" placeholders for planned areas (用户组 / 设备
 * 接入). 用户组 stays dropped — full RBAC groups are heavy for a read-only intranet console
 * whose three roles are near-identical. **设备接入 was un-dropped in Phase 18**: writing
 * config files (vehicles/formations) is operator-domain, not vehicle control, so it does not
 * breach the read-only red line, and it extends the codebook-import precedent. Every card
 * here is a real, navigable area.
 */
import { RouterLink } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";

interface Area {
  label: string;
  plan: string;
  to: string;
}

const AREAS: readonly Area[] = [
  { label: "设备接入", plan: "18", to: "/admin/onboarding" },
  { label: "用户", plan: "15E", to: "/admin/users" },
  { label: "审计", plan: "15E", to: "/admin/audit" },
  { label: "场景", plan: "13F", to: "/admin/scenes" },
  { label: "报码字典", plan: "16C", to: "/admin/codebook" },
  { label: "外发", plan: "16D", to: "/admin/notify" },
  { label: "系统状态", plan: "13F", to: "/admin/system" },
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
        </RouterLink>
      </li>
    </ul>
  </PageHeader>
</template>
