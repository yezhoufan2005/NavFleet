<script setup lang="ts">
/**
 * 管理 / 报码字典 — the code→meaning table in effect, and how to replace it.
 *
 * The console describes a vehicle's report codes against the table **in effect**: the
 * built-in reference table with the deployment's `codebook.json` layered over it. This page
 * shows that merged table and lets an admin swap the deployment layer — export the current
 * table as a starting point, edit the JSON, and import it back. Import is the one place the
 * console writes config (`PUT /api/v1/codebook`, admin-only, audited); the file it writes
 * needs the config volume to be writable (see deploy/docker-compose.yml). Everything below
 * import is read-only: the table is reference data, edited as a file, not row by row here.
 */
import { computed, onMounted, ref } from "vue";
import PageHeader from "@/components/PageHeader.vue";
import UiButton from "@/components/ui/UiButton.vue";
import { notify } from "@/composables/useNotifications";
import { useCodebook } from "@/composables/useCodebook";
import {
  CODE_IMPACTS,
  CODE_SUBSYSTEMS,
  parseCodebook,
  type CodeChannel,
  type ReportCodeEntry,
} from "@navfleet/shared";

const codebook = useCodebook();
const entries = codebook.entries;
const status = codebook.status;

onMounted(() => {
  // Force a fresh read: a prior device-detail visit may have populated the shared cache,
  // and an admin opening this page wants what the backend has now.
  void codebook.load(true);
});

const CHANNEL_LABELS: Record<CodeChannel, string> = {
  error: "告警",
  warning: "预警",
  info: "提示",
};

/** Download the current table as a codebook.json — a valid starting point to edit + re-import. */
const exportCodebook = (): void => {
  const blob = new Blob([`${JSON.stringify(entries.value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "codebook.json";
  anchor.click();
  URL.revokeObjectURL(url);
};

const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const importError = ref("");

const pickFile = (): void => {
  importError.value = "";
  fileInput.value?.click();
};

const onFileChosen = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // let the same file be chosen again after a fix
  if (!file) return;

  importError.value = "";
  let parsed: ReportCodeEntry[];
  try {
    const text = await file.text();
    // Validate client-side first so a bad file is caught before the round-trip; the backend
    // validates again with the same shared parser and is the real authority.
    parsed = parseCodebook(JSON.parse(text));
  } catch (error) {
    importError.value =
      error instanceof Error ? error.message : "文件不是有效的码表 JSON";
    return;
  }

  importing.value = true;
  try {
    await codebook.importCodebook(parsed);
    notify(`已导入 ${parsed.length} 条报码`, { type: "success" });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    importError.value =
      code === "invalid_codebook"
        ? "后端拒绝了这份码表，请检查内容"
        : code === "forbidden"
          ? "没有导入码表的权限"
          : "导入失败，请稍后重试";
  } finally {
    importing.value = false;
  }
};

const overrideHint = computed(() =>
  entries.value.length ? `共 ${entries.value.length} 条报码` : "",
);
</script>

<template>
  <PageHeader title="报码字典">
    <template #actions>
      <UiButton
        variant="secondary"
        size="sm"
        :disabled="!entries.length"
        @click="exportCodebook"
      >
        导出 JSON
      </UiButton>
      <UiButton size="sm" :disabled="importing" @click="pickFile">
        {{ importing ? "导入中…" : "导入 JSON" }}
      </UiButton>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        class="hidden"
        @change="onFileChosen"
      />
    </template>

    <p
      v-if="importError"
      class="m-0 rounded-sm border border-critical bg-critical-wash px-3 py-2 text-sm text-critical-ink"
      role="alert"
    >
      {{ importError }}
    </p>

    <p v-if="status === 'loading'" class="text-sm text-ink-muted" role="status">
      正在读取报码字典…
    </p>

    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="status"
    >
      报码字典加载失败，请稍后重试
    </p>

    <template v-else>
      <p class="m-0 text-xs text-ink-subtle">{{ overrideHint }}</p>

      <div class="overflow-x-auto rounded-md border border-border">
        <table class="w-full border-collapse text-sm">
          <caption class="sr-only">
            生效的报码字典：报码、名称、通道、等级、子系统、说明与处理建议
          </caption>
          <thead>
            <tr class="bg-surface-sunken text-left text-xs text-ink-muted">
              <th scope="col" class="px-3 py-2 font-medium">报码</th>
              <th scope="col" class="px-3 py-2 font-medium">名称</th>
              <th scope="col" class="px-3 py-2 font-medium">通道</th>
              <th scope="col" class="px-3 py-2 font-medium">等级</th>
              <th scope="col" class="px-3 py-2 font-medium">子系统</th>
              <th scope="col" class="px-3 py-2 font-medium">说明与处理建议</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in entries"
              :key="entry.code"
              class="border-t border-border align-top"
            >
              <td class="px-3 py-2 font-mono text-ink">{{ entry.code }}</td>
              <td class="px-3 py-2 text-ink">{{ entry.label }}</td>
              <td class="px-3 py-2 text-ink-muted">
                {{ CHANNEL_LABELS[entry.channel] }}
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {{ CODE_IMPACTS[entry.impact].label }}
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {{ CODE_SUBSYSTEMS[entry.subsystem] }}
              </td>
              <td class="px-3 py-2 text-ink-muted">
                <span class="text-ink">{{ entry.description }}</span>
                <br />
                {{ entry.hint }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </PageHeader>
</template>
