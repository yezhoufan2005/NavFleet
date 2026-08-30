<script setup lang="ts">
/**
 * 大屏值班 — a mode, not a section, which is why it is not in the navigation.
 *
 * Nobody "navigates to the wall display": a screen is mounted, pointed at this
 * address once, and left for months. Everything about it follows from that
 * (`docs/frontend-ia.md` §4):
 *
 * - **No shell.** `meta.bare` keeps the sidebar, top bar and session menu off the
 *   screen. It has to be non-interactive; a cursor and a menu on a wall are noise.
 * - **No session timeout**, which is the hard part. v1.0.0's refresh is
 *   fire-and-forget and does nothing when it fails, so one silent failure freezes a
 *   screen for months — and nothing on the screen says so. The refresh in
 *   `useAuth` now reacts to failure; the kiosk credential it needs is Phase 17C.
 * - **A freshness indicator is mandatory, not decorative.** Without "last updated
 *   at …" plus a colour change past a threshold, a frozen screen and a quiet fleet
 *   look identical from across the room.
 * - Readable at two metres, and nothing important in the bottom third — a display
 *   wall's lower edge sits around 1.2m and the front row of equipment blocks it.
 */
</script>

<template>
  <main class="grid min-h-dvh place-items-center bg-surface p-8">
    <div class="flex max-w-3xl flex-col items-center gap-4 text-center">
      <span
        class="rounded-full bg-notice-wash px-3 py-1 font-mono text-sm font-semibold text-notice-ink"
      >
        施工中 · PR 17C
      </span>
      <h1 class="text-wall-lg font-semibold text-ink">大屏值班模式</h1>
      <p class="text-wall-sm text-ink-muted">
        这一模式需要专用的 kiosk
        凭据、长期有效的会话，以及画面上的数据新鲜度指示 —— 三者都在 Phase 17C
        落地。当前只保留了不带外壳的渲染路径本身。
      </p>
    </div>
  </main>
</template>
