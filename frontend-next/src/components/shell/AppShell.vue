<script setup lang="ts">
/**
 * The application shell: top bar, sidebar, and the outlet the pages render into.
 *
 * Structure, and why each part is the element it is:
 *
 * - A skip link first, because the sidebar puts five links between the top of the
 *   document and the content on every single page. v1.0.0 had one; it is the one
 *   piece of its keyboard support that was already right.
 * - `AppTopBar` is the only `banner`. The sidebar is a plain `div` wrapping a
 *   `nav`, not an `aside` — `complementary` is reserved for page-level panels
 *   (the device list, the detail pane), and a navigation rail claiming that role
 *   would put a third landmark in every "jump to the side panel" list.
 * - `main` is focusable and takes focus after each navigation. Without it a
 *   keyboard user who activates a nav link stays parked in the sidebar and has to
 *   tab past everything again to reach what they just asked for.
 * - The error boundary sits *inside* the shell, keyed on the route path. A view
 *   that throws leaves the navigation usable, and walking away from it clears the
 *   fallback rather than stranding it on screen.
 *
 * Below `lg` the sidebar becomes a modal drawer. That uses Reka UI's `Dialog`
 * rather than a hand-rolled panel because the hard parts of a drawer are the ones
 * that are invisible until someone uses a keyboard: trapping focus inside it,
 * restoring focus to the trigger on dismissal, Escape, and marking the rest of the
 * page inert. Reka has all of that; a `v-if` and a scrim have none of it.
 */
import { onBeforeUnmount, useTemplateRef } from "vue";
import { RouterView, START_LOCATION, useRoute, useRouter } from "vue-router";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  VisuallyHidden,
} from "reka-ui";
import AppSidebarNav from "./AppSidebarNav.vue";
import AppTopBar from "./AppTopBar.vue";
import ErrorBoundary from "@/components/ErrorBoundary.vue";
import type { AuthUser } from "@/composables/useAuth";
import { useSidebar } from "@/composables/useSidebar";

const { user } = defineProps<{ user: AuthUser | null }>();
const emit = defineEmits<{ logout: [] }>();

const route = useRoute();
const router = useRouter();
const { mode, drawerOpen, isDrawer, labelled, toggle, closeDrawer } =
  useSidebar();

const mainRegion = useTemplateRef<HTMLElement>("mainRegion");

/**
 * Move focus to the content region **when the operator navigates**, and only then.
 *
 * This was a `watch` on `route.fullPath`, which fired in two cases it should not have —
 * both found in 14A acceptance, reported as "刷新页面，当前 tab 的边框会高亮":
 *
 * 1. **The first resolve after a reload.** `useRoute()` starts at `START_LOCATION`
 *    (`path: "/"`), and the auth guard is async, so on a reload of any page other than
 *    总览 the path changed *after* this component mounted — indistinguishable from a
 *    navigation. Focus landed on `main`, and because the reload itself was a keypress,
 *    Chrome's `:focus-visible` heuristic drew the ring: a teal outline around the whole
 *    page that nobody asked for. 总览 was the exception precisely because its path *is*
 *    `/`, so nothing appeared to change. A bug that spares exactly one page is a bug
 *    with a mechanism, and this was it.
 * 2. **A query-only change.** Every filter on 告警 writes the URL, so committing the
 *    debounced search box moved focus out of the input the operator was still typing in.
 *
 * `afterEach` rather than a watcher because it is handed both ends of the navigation:
 * `from === START_LOCATION` identifies the initial resolve exactly, and comparing paths
 * separates "went somewhere" from "changed a filter". Focus is for the first case only.
 */
const stopNavigationFocus = router.afterEach((to, from) => {
  closeDrawer();
  if (from === START_LOCATION || to.path === from.path) return;
  mainRegion.value?.focus();
});

onBeforeUnmount(stopNavigationFocus);
</script>

<template>
  <div class="flex h-dvh min-h-0 flex-col bg-surface">
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-brand focus:px-3 focus:py-2 focus:text-brand-contrast"
    >
      跳到主内容
    </a>

    <AppTopBar
      :user="user"
      :sidebar-mode="mode"
      @toggle-nav="toggle"
      @logout="emit('logout')"
    />

    <div class="flex min-h-0 flex-1">
      <!-- The rail. Rendered only above `lg`; below it the same nav lives in the
           drawer, so there is never a second copy in the accessibility tree. -->
      <div
        v-if="!isDrawer"
        class="flex shrink-0 flex-col border-r border-border bg-surface-raised transition-[width] duration-150 ease-standard"
        :class="labelled ? 'w-60' : 'w-11'"
      >
        <AppSidebarNav :labelled="labelled" />
      </div>

      <DialogRoot v-model:open="drawerOpen">
        <DialogPortal>
          <DialogOverlay class="fixed inset-0 z-40 bg-scrim/55" />
          <DialogContent
            class="fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-surface-raised shadow-drawer"
          >
            <VisuallyHidden>
              <DialogTitle>导航</DialogTitle>
              <DialogDescription>
                选择要打开的分区。按 Esc 关闭。
              </DialogDescription>
            </VisuallyHidden>
            <div class="flex justify-end border-b border-border p-2">
              <DialogClose
                class="grid size-8 place-items-center rounded-sm text-ink-muted transition-colors duration-150 ease-standard hover:bg-surface-sunken hover:text-ink"
                aria-label="关闭导航"
              >
                <svg
                  class="size-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </DialogClose>
            </div>
            <AppSidebarNav />
          </DialogContent>
        </DialogPortal>
      </DialogRoot>

      <!--
        The focus ring stays. It used to be `focus-visible:outline-none`, which fought a
        mechanism that was already correct: `:focus-visible` exists precisely so that a
        ring appears when the user arrived by keyboard and not when they arrived by
        mouse. Suppressing it re-created the problem the pseudo-class solves — and the
        case it broke is the skip link, whose only reason to exist is keyboard use. A
        skip link that moves focus without saying where it landed has done half its job.

        `-outline-offset-2` rather than the global `+2px`: this element is a
        `flex-1 overflow-y-auto` child, so an outline drawn *outside* its box is clipped
        by the scroll container. Inset, it is actually visible.
      -->
      <main
        id="main-content"
        ref="mainRegion"
        tabindex="-1"
        class="min-w-0 flex-1 overflow-y-auto p-4 focus-visible:-outline-offset-2 3xl:p-6"
      >
        <ErrorBoundary :reset-key="route.fullPath">
          <RouterView />
        </ErrorBoundary>
      </main>
    </div>
  </div>
</template>
