import { ref, watch, computed, type Ref } from "vue";
import type {
  Bookmark,
  ComicDocument,
  ReadingLocation,
} from "../../../shared/document";
import { makeId } from "../../../shared/commands";
import {
  readSession,
  writeSessions,
  type SavedSession,
} from "../lib/storage";
import type {
  PersistOutcome,
  PersistSession,
  SavedHistory,
} from "../../history/lib/types";
import { readingMetrics } from "../lib/metrics";

export interface PersistTarget {
  /** 依次尝试的压缩档位，靠后的更省空间。 */
  variants: () => SavedHistory[];
  /** 存档成功后回调，用于标记哪些历史步骤已落盘。 */
  persisted?: (history: SavedHistory | null) => void;
}

export function useProgress(
  doc: Ref<ComicDocument>,
  location: Ref<ReadingLocation>,
  saved: SavedSession | null,
) {
  const bookmarks = ref<Bookmark[]>(saved?.bookmarks ?? []),
    status = ref("本地自动保存已开启"),
    metrics = computed(() => readingMetrics(doc.value, location.value));
  let target: PersistTarget | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function attach(next: PersistTarget) {
    target = next;
  }

  /** 把给定会话按压缩档位依次写入；全部失败时本地存档保持原样。 */
  function persist(session: PersistSession, variants: SavedHistory[]): PersistOutcome {
    const candidates: SavedSession[] = variants.length
      ? variants.map((history) => ({ ...session, history }))
      : [{ ...session }];
    const outcome = writeSessions(candidates);
    if (outcome.ok && outcome.saved) {
      status.value = outcome.message;
      const history = outcome.saved.history ?? null;
      target?.persisted?.(history);
      return { ok: true, message: outcome.message, snapshot: history };
    }
    status.value = outcome.message;
    target?.persisted?.(null);
    return { ok: false, message: outcome.message, snapshot: null };
  }

  function save() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const variants = target ? target.variants() : [];
    persist(
      {
        document: doc.value,
        location: location.value,
        bookmarks: bookmarks.value,
      },
      variants,
    );
  }

  /** 文档、位置、书签与历史常在同一次操作里变化，合并成一次写入。 */
  function scheduleSave() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      save();
    }, 80);
  }

  watch([doc, location, bookmarks], scheduleSave, { deep: true });

  function add() {
    const same = bookmarks.value.find(
      (b) =>
        b.location.pageId === location.value.pageId &&
        b.location.panelId === location.value.panelId,
    );
    if (same) {
      status.value = "此处分镜已收藏";
      return;
    }
    const c = doc.value.chapters.find((c) => c.id === location.value.chapterId);
    bookmarks.value.push({
      id: makeId("bookmark"),
      label: `${c?.title ?? "章节"} · 第 ${metrics.value.pageIndex} 页`,
      location: { ...location.value },
      created: Date.now(),
    });
  }

  function remove(id: string) {
    bookmarks.value = bookmarks.value.filter((b) => b.id !== id);
  }

  function reconcile() {
    const ids = new Set(
      doc.value.chapters.flatMap((c) => c.pages.map((p) => p.id)),
    );
    bookmarks.value = bookmarks.value.filter((b) => ids.has(b.location.pageId));
  }

  function setBookmarks(next: Bookmark[]) {
    bookmarks.value = next;
  }

  return {
    bookmarks,
    status,
    metrics,
    add,
    remove,
    reconcile,
    save,
    setBookmarks,
    persist,
    attach,
  };
}

export { readSession };
