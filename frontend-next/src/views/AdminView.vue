<script setup lang="ts">
/**
 * 管理 — an aggregate section, so it gets a real landing page.
 *
 * Constraint C2: clicking an aggregate must not drop you into whichever child happens to be
 * first. This page is the map of the section — one card per built admin area.
 *
 * Cards are filtered by capability (1.6.1 RBAC): a user reaching this landing holds at least one
 * admin-area capability, and sees only the areas they can actually enter. 用户 与 角色与用户组 have
 * moved out to their own top-level 用户 section (1.6.2 IA), so they are no longer cards here.
 * 系统状态 has no dedicated capability, so it shows to anyone who can reach this landing.
 */
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { Capability } from "@navfleet/shared";
import PageHeader from "@/components/PageHeader.vue";
import { useAuth } from "@/composables/useAuth";

interface Area {
  label: string;
  plan: string;
  to: string;
  /** Capability that gates the area; absent = shown to anyone on the landing (系统状态). */
  capability?: Capability;
}

const AREAS: readonly Area[] = [
  {
    label: "设备接入",
    plan: "18",
    to: "/admin/onboarding",
    capability: "vehicles:write",
  },
  { label: "审计", plan: "15E", to: "/admin/audit", capability: "audit:read" },
  {
    label: "场景",
    plan: "13F",
    to: "/admin/scenes",
    capability: "scenes:write",
  },
  {
    label: "报码字典",
    plan: "16C",
    to: "/admin/codebook",
    capability: "codebook:write",
  },
  {
    label: "外发",
    plan: "16D",
    to: "/admin/notify",
    capability: "notify:read",
  },
  { label: "系统状态", plan: "13F", to: "/admin/system" },
];

const { can } = useAuth();
const areas = computed(() =>
  AREAS.filter((area) => !area.capability || can(area.capability)),
);

const CARD_BASE =
  "flex h-full flex-col gap-1 rounded-md bg-surface-raised p-4 transition-colors duration-150 ease-standard";
</script>

<template>
  <PageHeader title="管理">
    <ul class="grid list-none gap-3 p-0 md:grid-cols-2 3xl:grid-cols-3">
      <li v-for="area in areas" :key="area.label">
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
