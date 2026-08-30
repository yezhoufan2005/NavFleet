<script setup lang="ts">
/**
 * Unknown address.
 *
 * Shows the address that was not found rather than redirecting to the landing page.
 * A silent redirect reads as "the application ignored what I typed", and it hides
 * the actual cause — which is usually a stale bookmark or a truncated link, both of
 * which the person can fix once they can see the address.
 *
 * The address is `route.fullPath` as-is. v1.0.0 printed it with a `#` in front
 * because it used hash routing; now that the router uses real paths, prefixing one
 * would print an address that does not exist.
 */
import { RouterLink, useRoute } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import UiButton from "@/components/ui/UiButton.vue";

const route = useRoute();
</script>

<template>
  <PageHeader
    title="页面不存在"
    lede="这个地址没有对应的页面，其余功能不受影响。"
  >
    <div class="flex flex-col items-start gap-4">
      <p
        class="rounded-sm bg-surface-sunken px-3 py-2 font-mono text-sm break-all text-ink-muted"
      >
        {{ route.fullPath }}
      </p>
      <!-- `custom` so the anchor stays an anchor: this is navigation, and a
           <a> wrapping a <button> would be invalid markup with two controls. -->
      <RouterLink v-slot="{ href, navigate }" to="/" custom>
        <UiButton as="a" variant="secondary" :href="href" @click="navigate">
          返回总览
        </UiButton>
      </RouterLink>
    </div>
  </PageHeader>
</template>
