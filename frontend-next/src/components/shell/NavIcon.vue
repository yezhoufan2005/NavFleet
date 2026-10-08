<script setup lang="ts">
/**
 * The seven primary-navigation glyphs, inline.
 *
 * Inline rather than an icon package: a handful of icons do not justify a dependency, and
 * a sprite or font would add a request on the critical path of a console whose
 * whole CSS budget is 14 KB gzip. Each is a 24×24 stroke path that inherits
 * `currentColor`, so the token layer colours them with no per-icon rule.
 *
 * `aria-hidden` is unconditional. Every icon in the shell sits next to a text
 * label, or inside a control that carries its own accessible name — an icon that
 * announced itself would make every nav item read twice.
 */
import type { NavIconName } from "@/router";

const { name } = defineProps<{ name: NavIconName }>();

/**
 * Paths only, so the wrapper below owns every shared attribute. Written as a
 * literal record rather than assembled, for the same reason the class names are:
 * something a build step has to be able to see.
 *
 * Circles are drawn as two half-arcs (`a r r 0 1 0 …`) rather than `<circle>`
 * elements so that every icon is exactly one `<path>` and the template stays a
 * single element instead of a switch.
 */
const PATHS: Record<NavIconName, string> = {
  // A gauge: the overview answers "how is the fleet doing", not "where is it".
  overview: "M4 15a8 8 0 0 1 16 0M12 15l4.5-4.5",
  // A vehicle in plan view: body, cab, two wheels.
  devices:
    "M3 8h12v6H3zM15 10h3.5l2.5 3v1H15zM5.5 17.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0M15.3 17.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0",
  // A bell, not a warning triangle: the triangle is the severity mark used inside
  // the page, and reusing it for the section would blur the two.
  alerts:
    "M9.5 18.5a2.5 2.5 0 0 0 5 0M6 15.5V10a6 6 0 1 1 12 0v5.5l1.6 2.5H4.4z",
  reports: "M4 20V4M4 20h16M8 17v-5M12.5 17V8M17 17v-7",
  // A single person, head and shoulders: 用户 is access control, kept distinct from the
  // 管理 sliders below and from the 设备 vehicle above.
  users:
    "M8.9 8.5a3.1 3.1 0 1 0 6.2 0a3.1 3.1 0 1 0-6.2 0M5.5 19a6.5 6.5 0 0 1 13 0",
  // A 3D package/box: 部署 writes deployment config (vehicles / scenes / codebook) to disk,
  // kept distinct from the 系统 sliders and the 设备 vehicle.
  deploy: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
  // Sliders: two tracks, one handle on each — 系统 (系统状态 / 审计 / 外发) is the operations
  // console, the knobs-and-dials section.
  system:
    "M4 8.5h4.4M11.6 8.5H20M4 15.5h9.4M16.6 15.5H20M8.4 8.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0M13.4 15.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0",
};
</script>

<template>
  <svg
    class="size-5 shrink-0"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="PATHS[name]" />
  </svg>
</template>
