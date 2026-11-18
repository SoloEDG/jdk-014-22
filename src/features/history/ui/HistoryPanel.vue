<script setup lang="ts">
import { computed, ref } from "vue";
import {
  History as HistoryIcon,
  Undo2,
  Redo2,
  Download,
  ChevronDown,
  ChevronUp,
  TriangleAlert,
} from "lucide-vue-next";
import type { HistoryRuntime } from "../model/history";
import { formatSize } from "../model/history";
const props = defineProps<{ history: HistoryRuntime }>();
const h = props.history;
const open = ref(true);
const limits = [
  { value: 600_000, label: "紧凑" },
  { value: 2_000_000, label: "标准" },
  { value: 6_000_000, label: "宽松" },
];
const usageLabel = computed(() => {
  const used = h.usage.value;
  const limit = h.limit.value;
  const percent = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return { text: `${formatSize(used)} / ${formatSize(limit)}`, percent };
});
const rows = computed(() => [...h.rows.value].reverse());
function time(at: number) {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function jump(row: { index: number; applied: boolean; blockedReason: string }) {
  const entry = h.entries.value[row.index];
  if (!entry) return;
  h.gotoStep(entry.id);
}
</script>

<template>
  <section class="history-panel">
    <div class="section-heading">
      <button class="history-toggle" @click="open = !open">
        <HistoryIcon :size="14" /> 编辑历史
        <ChevronUp v-if="open" :size="13" /><ChevronDown v-else :size="13" />
      </button>
      <span class="muted">{{ h.rows.value.length }} 步</span>
    </div>

    <div class="history-toolbar">
      <button
        class="history-action"
        :disabled="!h.canUndo.value"
        :title="h.canUndo.value ? `撤销：${h.undoLabel.value}` : '没有可撤销的步骤'"
        @click="h.undo()"
      >
        <Undo2 :size="13" /> 撤销
      </button>
      <button
        class="history-action"
        :disabled="!h.canRedo.value"
        :title="h.canRedo.value ? `重做：${h.redoLabel.value}` : '没有可重做的步骤'"
        @click="h.redo()"
      >
        <Redo2 :size="13" /> 重做
      </button>
    </div>

    <template v-if="open">
      <div class="history-meter" :title="usageLabel.text">
        <div><i :style="{ width: `${usageLabel.percent}%` }"></i></div>
        <span>{{ usageLabel.text }}</span>
      </div>
      <label class="history-limit">
        <span>历史占用上限</span>
        <select
          :value="h.limit.value"
          aria-label="历史占用上限"
          @change="h.setLimit(Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="l in limits" :key="l.value" :value="l.value">
            {{ l.label }} · {{ formatSize(l.value) }}
          </option>
          <option
            v-if="!limits.some((l) => l.value === h.limit.value)"
            :value="h.limit.value"
          >
            上次设置 · {{ formatSize(h.limit.value) }}
          </option>
        </select>
      </label>

      <ol v-if="rows.length" class="history-list">
        <li
          v-for="row in rows"
          :key="row.id"
          :class="{
            current: row.index === h.cursor.value - 1,
            future: !row.applied,
            blocked: !!row.blockedReason,
          }"
        >
          <button
            class="history-jump"
            :disabled="!!row.blockedReason"
            :title="row.blockedReason || (row.applied ? '回到这一步之后' : '重做到这一步')"
            @click="jump(row)"
          >
            <span class="history-dot"></span>
            <span class="history-text">
              <strong>{{ row.label }}</strong>
              <small>
                {{ time(row.at) }}
                <template v-if="!row.applied"> · 已撤销，可重做</template>
                <template v-else-if="row.index === h.cursor.value - 1">
                  · 当前
                </template>
              </small>
            </span>
          </button>
          <span v-if="row.sessionOnly" class="history-tag">仅本页</span>
          <span v-else-if="row.payloadAtRisk" class="history-tag warn">重开不可撤销</span>
          <span v-if="row.blockedReason" class="history-blocked">
            <TriangleAlert :size="11" /> {{ row.blockedReason }}
          </span>
        </li>
      </ol>
      <p v-else class="history-empty">重命名、排序或删除章节后，可在这里回退。</p>
      <button
        v-if="rows.length && h.cursor.value > 0"
        class="history-rewind"
        @click="h.undoAll()"
      >
        <Undo2 :size="11" /> 回到最初
      </button>

      <p v-if="h.evictedCount.value" class="history-note">
        已有 {{ h.evictedCount.value }} 步较早操作因占用上限被移出历史，无法再回退<template
          v-if="h.evictedLabels.value.length"
          >（如：{{ h.evictedLabels.value.slice(-2).join("、") }}）</template
        >。
      </p>
      <p v-if="h.unavailableCount.value" class="history-note warn">
        为节省本地空间，最近一次保存省略了 {{ h.unavailableCount.value }}
        步历史<template v-if="h.unavailableLabels.value.length"
          >（{{ h.unavailableLabels.value.join("、") }}）</template
        >，重开后它们只保留说明、不可回退。
      </p>
      <p v-if="h.notice.value" class="history-notice" role="status">
        {{ h.notice.value }}
        <button aria-label="关闭提示" @click="h.clearNotice()">×</button>
      </p>

      <div v-if="h.pending.value" class="history-pending" role="alert">
        <strong><TriangleAlert :size="12" /> 有待恢复内容</strong>
        <p>{{ h.pending.value.reason }}</p>
        <div>
          <button @click="h.undo()"><Undo2 :size="12" /> 重试撤销</button>
          <button @click="h.exportPending()">
            <Download :size="12" /> 导出待恢复内容
          </button>
          <button @click="h.dismissPending()">放弃</button>
        </div>
      </div>
    </template>
  </section>
</template>
