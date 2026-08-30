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
import { watch, useTemplateRef } from "vue";
import { RouterView, useRoute } from "vue-router";
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
const { mode, drawerOpen, isDrawer, labelled, toggle, closeDrawer } =
  useSidebar();

const mainRegion = useTemplateRef<HTMLElement>("mainRegion");

watch(
  () => route.fullPath,
  () => {
    closeDrawer();
    mainRegion.value?.focus();
  },
);
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

      <main
        id="main-content"
        ref="mainRegion"
        tabindex="-1"
        class="min-w-0 flex-1 overflow-y-auto p-4 focus-visible:outline-none 3xl:p-6"
      >
        <ErrorBoundary :reset-key="route.fullPath">
          <RouterView />
        </ErrorBoundary>
      </main>
    </div>
  </div>
</template>
