import { computed, ref, type Ref } from "vue";
import type {
  Bookmark,
  Chapter,
  ComicDocument,
  ReadingLocation,
} from "../../../shared/document";
import type { ReaderCommand } from "../../../shared/commands";
import { makeId } from "../../../shared/commands";
import { normalize } from "../../reader/lib/navigation";
import type {
  DeleteHistoryEntry,
  HistoryEntry,
  HistoryItemView,
  MoveHistoryEntry,
  NewHistoryEntry,
  OrderAnchor,
  PendingRestore,
  PersistOutcome,
  PersistResult,
  PersistSession,
  RemovedBookmark,
  RenameHistoryEntry,
  SavedHistory,
} from "../lib/types";

const DEFAULT_LIMIT = 2_000_000;
const MAX_ENTRIES = 200;

export interface HistoryDeps {
  bookmarks(): Bookmark[];
  setBookmarks(next: Bookmark[]): void;
  /** 章节结构变化后让阅读位置与书签重新对齐。 */
  sync(): void;
  /** 在真正改动文档之前，先把候选状态写进本地存储；失败时调用方必须保持原状。 */
  persist(
    session: PersistSession,
    historyVariants: SavedHistory[],
  ): PersistOutcome;
  /** 只改历史设置（如占用上限）后，主动触发一次存档。 */
  save?(): void;
}

export interface ReaderLike {
  location: { value: ReadingLocation };
  /** 用户手动导航的累计次数；用于判断某一步之后位置是否被人为挪动。 */
  moves: { value: number };
  dispatch(command: ReaderCommand): void;
  reconcile(): void;
}

const cloneJson = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));
const cloneLocation = (location: ReadingLocation): ReadingLocation => ({
  ...location,
});
const entrySize = (entry: unknown): number => {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
};

function anchorAt(chapters: Chapter[], index: number): OrderAnchor {
  return {
    prevId: chapters[index - 1]?.id ?? null,
    nextId: chapters[index + 1]?.id ?? null,
    index,
  };
}

function anchorIndex(chapters: Chapter[], anchor: OrderAnchor): number {
  if (anchor.prevId) {
    const prev = chapters.findIndex((c) => c.id === anchor.prevId);
    if (prev >= 0) return prev + 1;
  }
  if (anchor.nextId) {
    const next = chapters.findIndex((c) => c.id === anchor.nextId);
    if (next >= 0) return next;
  }
  return Math.max(0, Math.min(chapters.length, anchor.index));
}

function pageIdsOf(chapter: Chapter): Set<string> {
  return new Set(chapter.pages.map((p) => p.id));
}

/** 被删章节的页面 id 是否与现有章节撞车（重建/重复导入后的引用冲突）。 */
function hasPageConflict(doc: ComicDocument, chapter: Chapter): boolean {
  const other = new Set<string>();
  for (const c of doc.chapters) {
    for (const p of c.pages) other.add(p.id);
  }
  return chapter.pages.some((p) => other.has(p.id));
}

function sameSpot(
  a: { chapterId: string; pageId: string; panelId: string },
  b: { chapterId: string; pageId: string; panelId: string },
): boolean {
  return (
    a.chapterId === b.chapterId &&
    a.pageId === b.pageId &&
    a.panelId === b.panelId
  );
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<HistoryEntry>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.label !== "string" ||
    typeof entry.at !== "number" ||
    typeof entry.locationBefore?.chapterId !== "string" ||
    typeof entry.locationAfter?.chapterId !== "string"
  )
    return false;
  if (entry.kind === "rename")
    return (
      typeof entry.chapterId === "string" &&
      typeof entry.before === "string" &&
      typeof entry.after === "string"
    );
  if (entry.kind === "move")
    return (
      typeof entry.chapterId === "string" &&
      typeof entry.from === "number" &&
      typeof entry.to === "number"
    );
  if (entry.kind === "delete")
    return (
      typeof entry.chapterId === "string" &&
      typeof entry.index === "number" &&
      Array.isArray(entry.bookmarks) &&
      (entry.chapter === null || Array.isArray(entry.chapter?.pages))
    );
  return false;
}

function validSavedEntries(saved?: SavedHistory): HistoryEntry[] {
  if (!saved || !Array.isArray(saved.entries)) return [];
  return saved.entries.filter(isHistoryEntry).map((entry) => {
    const copy = entry as HistoryEntry;
    copy.size =
      typeof copy.size === "number" && copy.size > 0 ? copy.size : entrySize(copy);
    if (copy.kind === "delete") {
      copy.bookmarks = (copy.bookmarks ?? []).filter(
        (item) =>
          item &&
          typeof item.index === "number" &&
          item.bookmark &&
          typeof item.bookmark.id === "string",
      );
      if (!copy.chapter) copy.payloadDropped = true;
    }
    return copy;
  });
}

export function formatSize(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
  if (chars >= 1_000) return `${Math.round(chars / 1_000)} KB`;
  return `${chars} 字符`;
}

export function useHistory(
  doc: Ref<ComicDocument>,
  reader: ReaderLike,
  deps: HistoryDeps,
  saved?: SavedHistory,
) {
  const loaded = validSavedEntries(saved);
  const entries = ref<HistoryEntry[]>(loaded);
  const cursor = ref(
    Math.max(0, Math.min(loaded.length, saved?.cursor ?? loaded.length)),
  );
  const limit = ref(
    Math.max(
      100_000,
      Math.min(20_000_000, saved?.limit || DEFAULT_LIMIT),
    ),
  );
  const notice = ref("");
  // 接着上次的手动导航计数，保证重开后仍能判断阅读位置是否被人为挪动。
  if (saved && typeof saved.moves === "number" && saved.moves > reader.moves.value)
    reader.moves.value = saved.moves;
  const pending = ref<PendingRestore | null>(null);
  const evictedCount = ref(saved?.evictedCount ?? 0);
  const evictedLabels = ref<string[]>(saved?.evictedLabels ?? []);
  /** 已写入本地存储的历史 id。 */
  const savedIds = ref<Set<string>>(new Set(loaded.map((entry) => entry.id)));
  /** 本次会话是否已发生一次写入失败；失败后新步骤才标记为“仅本页”。 */
  const storageFailed = ref(false);
  /** 本次存档后只能看、不能撤销的步骤 id。 */
  const atRisk = ref<Set<string>>(new Set());
  /** 最近一次存档中没能写下、重开后不可回退的步骤数量与名称。 */
  const unavailableCount = ref(saved?.unavailableCount ?? 0);
  const unavailableLabels = ref<string[]>(
    saved?.unavailableLabels ?? [],
  );

  const usage = computed(() =>
    entries.value.reduce((sum, entry) => sum + entry.size, 0),
  );

  function note(text: string) {
    notice.value = text;
  }

  function fail(message: string): PersistResult {
    note(message);
    return { ok: false, message };
  }

  function chapterOf(id: string): Chapter | undefined {
    return doc.value.chapters.find((c) => c.id === id);
  }

  function blockedReason(entry: HistoryEntry, applied: boolean): string {
    if (entry.kind === "delete") {
      if (!applied) {
        // 重做删除只需要章节仍在文档里；章节快照缺失不影响。
        return chapterOf(entry.chapterId) ? "" : "章节已不存在，无法重做删除";
      }
      if (!entry.chapter)
        return "章节内容未保存在历史中，无法撤销（可重新导入）";
      if (chapterOf(entry.chapter.id))
        return "同名章节已存在，撤销会与现有章节冲突";
      if (hasPageConflict(doc.value, entry.chapter))
        return "页面标识与现有章节冲突，无法自动恢复";
      return "";
    }
    if (!chapterOf(entry.chapterId)) return "章节已不存在，无法回退";
    return "";
  }

  const rows = computed<HistoryItemView[]>(() =>
    entries.value.map((entry, index) => {
      const applied = index < cursor.value;
      return {
        id: entry.id,
        label: entry.label,
        at: entry.at,
        kind: entry.kind,
        index,
        applied,
        sessionOnly: storageFailed.value && !savedIds.value.has(entry.id),
        payloadAtRisk: atRisk.value.has(entry.id),
        blockedReason: blockedReason(entry, applied),
      };
    }),
  );

  const canUndo = computed(() => {
    if (cursor.value <= 0) return false;
    const entry = entries.value[cursor.value - 1];
    return !!entry && !blockedReason(entry, true);
  });
  const canRedo = computed(() => {
    if (cursor.value >= entries.value.length) return false;
    const entry = entries.value[cursor.value];
    return !!entry && !blockedReason(entry, false);
  });
  const undoLabel = computed(() => {
    const entry = entries.value[cursor.value - 1];
    return entry ? entry.label : "";
  });
  const redoLabel = computed(() => {
    const entry = entries.value[cursor.value];
    return entry ? entry.label : "";
  });

  /* ---------- 体积限制与淘汰 ---------- */

  function evictOldest(): boolean {
    if (entries.value.length <= 1) return false;
    const index =
      cursor.value > 0 ? 0 : entries.value.length - 1;
    const removed = entries.value[index];
    if (!removed) return false;
    entries.value.splice(index, 1);
    if (index < cursor.value) cursor.value--;
    evictedCount.value++;
    evictedLabels.value = [...evictedLabels.value, removed.label].slice(-8);
    return true;
  }

  function enforceLimit() {
    let evicted = 0;
    while (usage.value > limit.value && entries.value.length > 1) {
      if (!evictOldest()) break;
      evicted++;
    }
    while (entries.value.length > MAX_ENTRIES) {
      if (!evictOldest()) break;
      evicted++;
    }
    if (usage.value > limit.value) {
      note(
        `最近一步的历史快照约 ${formatSize(usage.value)}，已超出占用上限；较早的步骤已优先移出，这一步会尽量保留。`,
      );
    } else if (evicted > 0) {
      note(
        `历史占用达到上限，已移出 ${evicted} 步较早操作，这些步骤不能再回退。`,
      );
    }
  }

  function addEntry(input: NewHistoryEntry) {
    if (cursor.value < entries.value.length)
      entries.value.splice(cursor.value);
    const entry = {
      ...input,
      id: makeId("history"),
      at: Date.now(),
      size: 0,
    } as HistoryEntry;
    entry.size = entrySize(entry);
    entries.value.push(entry);
    cursor.value = entries.value.length;
    enforceLimit();
  }

  /* ---------- 章节操作 ---------- */

  function renameChapter(id: string, title: string): PersistResult {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 60)
      return fail("章节名需为 1–60 个字");
    const chapter = chapterOf(id);
    if (!chapter) return fail("章节已不存在");
    if (chapter.title === trimmed) return { ok: true, message: "" };
    const before = chapter.title;
    chapter.title = trimmed;
    const at = cloneLocation(reader.location.value);
    addEntry({
      kind: "rename",
      label: `重命名「${before}」→「${trimmed}」`,
      chapterId: id,
      before,
      after: trimmed,
      locationBefore: at,
      locationAfter: cloneLocation(at),
    });
    return { ok: true, message: "" };
  }

  function moveChapter(id: string, delta: number): PersistResult {
    const chapters = doc.value.chapters;
    const from = chapters.findIndex((c) => c.id === id);
    const to = from + delta;
    if (from < 0) return fail("章节已不存在");
    if (to < 0 || to >= chapters.length) return fail("已到章节列表边界");
    const chapter = chapters[from]!;
    const undoAnchor = anchorAt(chapters, from);
    chapters.splice(from, 1);
    chapters.splice(to, 0, chapter);
    const redoAnchor = anchorAt(chapters, to);
    const at = cloneLocation(reader.location.value);
    addEntry({
      kind: "move",
      label: `移动《${chapter.title}》至第 ${to + 1} 位`,
      chapterId: id,
      title: chapter.title,
      from,
      to,
      undoAnchor,
      redoAnchor,
      locationBefore: at,
      locationAfter: cloneLocation(at),
    });
    return { ok: true, message: "" };
  }

  function deleteChapter(id: string): PersistResult {
    const chapters = doc.value.chapters;
    if (chapters.length < 2) return fail("至少保留一个章节");
    const index = chapters.findIndex((c) => c.id === id);
    const chapter = chapters[index];
    if (!chapter) return fail("章节已不存在");

    const locationBefore = cloneLocation(reader.location.value);
    const touched = locationBefore.chapterId === id;
    const anchor = anchorAt(chapters, index);
    const snapshot = cloneJson(chapter);
    const pages = pageIdsOf(chapter);

    const remaining = chapters.filter((c) => c.id !== id);
    // 被删的是当前章节时，落到相邻章节开头；其余情况位置不动。
    const fallback = remaining[Math.min(index, remaining.length - 1)];
    const nextLocation = touched
      ? {
          chapterId: fallback?.id ?? "",
          pageId: fallback?.pages[0]?.id ?? "",
          panelId: fallback?.pages[0]?.panels[0]?.id ?? "",
          zoom: 1,
          x: 0,
          y: 0,
        }
      : cloneLocation(locationBefore);

    const allMarks = deps.bookmarks();
    const removed: RemovedBookmark[] = [];
    allMarks.forEach((bookmark, markIndex) => {
      if (pages.has(bookmark.location.pageId))
        removed.push({ index: markIndex, bookmark: cloneJson(bookmark) });
    });

    chapters.splice(index, 1);
    deps.setBookmarks(allMarks.filter((b) => !pages.has(b.location.pageId)));
    reader.dispatch({ type: "restore", location: nextLocation });
    deps.sync();

    addEntry({
      kind: "delete",
      chapterId: id,
      index,
      anchor,
      label: `删除《${chapter.title}》（${chapter.pages.length} 页）`,
      chapter: snapshot,
      bookmarks: removed,
      locationTouched: touched,
      locationBefore,
      locationAfter: cloneLocation(reader.location.value),
      movesAfter: reader.moves.value,
    });
    note("已删除章节；可在编辑历史中撤销恢复。");
    return { ok: true, message: "" };
  }

  /* ---------- 撤销与重做 ---------- */

  function restoreBookmarksFor(
    current: Bookmark[],
    removed: RemovedBookmark[],
    chapter: Chapter,
  ): Bookmark[] {
    const result = current.map((b) => cloneJson(b));
    const ids = new Set(result.map((b) => b.id));
    const pages = pageIdsOf(chapter);
    for (const item of [...removed].sort((a, b) => a.index - b.index)) {
      const mark = item.bookmark;
      if (!mark || ids.has(mark.id)) continue;
      if (!pages.has(mark.location.pageId)) continue;
      const conflict = result.some(
        (b) =>
          b.location.pageId === mark.location.pageId &&
          b.location.panelId === mark.location.panelId,
      );
      if (conflict) continue;
      const copy = cloneJson(mark);
      result.splice(
        Math.max(0, Math.min(item.index, result.length)),
        0,
        copy,
      );
      ids.add(copy.id);
    }
    return result;
  }

  function revertRename(entry: RenameHistoryEntry): string {
    const chapter = chapterOf(entry.chapterId);
    if (!chapter) return "章节已不存在，无法撤销重命名";
    chapter.title = entry.before;
    return "";
  }

  function redoRename(entry: RenameHistoryEntry): string {
    const chapter = chapterOf(entry.chapterId);
    if (!chapter) return "章节已不存在，无法重做重命名";
    chapter.title = entry.after;
    return "";
  }

  function moveTo(
    chapters: Chapter[],
    id: string,
    anchor: OrderAnchor,
  ): boolean {
    const index = chapters.findIndex((c) => c.id === id);
    if (index < 0) return false;
    const [chapter] = chapters.splice(index, 1);
    if (!chapter) return false;
    chapters.splice(anchorIndex(chapters, anchor), 0, chapter);
    return true;
  }

  function revertDelete(entry: DeleteHistoryEntry): string {
    const chapter = entry.chapter;
    if (!chapter) return "这一步的章节内容没有保存，无法撤销删除";
    if (chapterOf(chapter.id))
      return "章节已存在，无法恢复（可能已重新导入）";
    if (hasPageConflict(doc.value, chapter))
      return "页面标识与现有章节冲突，无法安全恢复";

    const chapters = [...doc.value.chapters];
    chapters.splice(anchorIndex(chapters, entry.anchor), 0, cloneJson(chapter));
    const bookmarks = restoreBookmarksFor(
      deps.bookmarks(),
      entry.bookmarks,
      chapter,
    );

    const candidateDoc: ComicDocument = { ...doc.value, chapters };
    const current = cloneLocation(reader.location.value);
    // 只有位置还停在删除留下的地方、且之后没有手动翻过，才带它回删除前的位置。
    const settled =
      entry.locationTouched &&
      reader.moves.value === (entry.movesAfter ?? reader.moves.value) &&
      sameSpot(current, entry.locationAfter);
    const nextLocation = normalize(
      candidateDoc,
      settled ? cloneLocation(entry.locationBefore) : current,
    );

    // 先试写：空间不足时保持撤销前的状态，不产生半完成状态。
    const outcome = deps.persist(
      { document: candidateDoc, location: nextLocation, bookmarks },
      snapshotsAt(cursor.value - 1),
    );
    if (!outcome.ok) {
      pending.value = {
        reason:
          "本地存储空间不足，无法连同被删章节一起保存；撤销前的状态已保持。",
        at: Date.now(),
        steps: [
          {
            label: entry.label,
            kind: "delete",
            at: entry.at,
            chapter: cloneJson(chapter),
            bookmarks: entry.bookmarks.map((item) => cloneJson(item.bookmark)),
          },
        ],
      };
      note(
        "恢复空间不足，撤销未执行；可导出待恢复内容，腾出空间后再试。",
      );
      return "空间不足，未执行撤销；待恢复内容可导出";
    }

    doc.value.chapters = chapters;
    deps.setBookmarks(bookmarks);
    reader.dispatch({ type: "restore", location: nextLocation });
    pending.value = null;
    entry.movesAfterUndo = reader.moves.value;
    cursor.value--;
    if (outcome.snapshot) notePersisted(outcome.snapshot);
    note(
      `已撤销删除《${chapter.title}》：页面、对白、声音与书签已恢复。`,
    );
    return "";
  }

  function redoDelete(entry: DeleteHistoryEntry): string {
    const chapter = chapterOf(entry.chapterId);
    if (!chapter) return "章节已不存在，无法重做删除";
    const index = doc.value.chapters.indexOf(chapter);
    const pages = pageIdsOf(chapter);
    const marks = deps.bookmarks();
    const removed: RemovedBookmark[] = [];
    marks.forEach((bookmark, markIndex) => {
      if (pages.has(bookmark.location.pageId))
        removed.push({ index: markIndex, bookmark: cloneJson(bookmark) });
    });
    const chapters = [...doc.value.chapters];
    chapters.splice(index, 1);
    const candidateDoc: ComicDocument = { ...doc.value, chapters };
    const current = cloneLocation(reader.location.value);
    // 撤销后用户手动跳到别章时，重做不应把他强行拉回旧阅读点。
    const settled =
      entry.locationTouched &&
      reader.moves.value ===
        (entry.movesAfterUndo ?? entry.movesAfter ?? reader.moves.value) &&
      sameSpot(current, entry.locationBefore);
    const nextLocation = settled
      ? normalize(candidateDoc, cloneLocation(entry.locationAfter))
      : current;

    doc.value.chapters = chapters;
    deps.setBookmarks(marks.filter((b) => !pages.has(b.location.pageId)));
    reader.dispatch({ type: "restore", location: nextLocation });
    deps.sync();

    entry.chapter = cloneJson(chapter);
    entry.bookmarks = removed;
    entry.locationTouched = current.chapterId === chapter.id;
    entry.locationBefore = current;
    entry.locationAfter = cloneLocation(reader.location.value);
    entry.movesAfter = reader.moves.value;
    entry.size = entrySize(entry);
    cursor.value++;
    enforceLimit();
    note(`已重做删除《${chapter.title}》。`);
    return "";
  }

  function undo(): PersistResult {
    if (cursor.value <= 0) return fail("没有可撤销的步骤");
    const entry = entries.value[cursor.value - 1]!;
    let reason = "";
    if (entry.kind === "rename") {
      reason = revertRename(entry);
      if (!reason) {
        cursor.value--;
        note(`已撤销：${entry.label}`);
      }
    } else if (entry.kind === "move") {
      reason = moveTo(doc.value.chapters, entry.chapterId, entry.undoAnchor)
        ? ""
        : "章节已不存在，无法撤销排序";
      if (!reason) {
        cursor.value--;
        note(`已撤销：${entry.label}`);
      }
    } else {
      reason = revertDelete(entry);
    }
    return reason ? fail(reason) : { ok: true, message: "" };
  }

  function redo(): PersistResult {
    if (cursor.value >= entries.value.length)
      return fail("没有可重做的步骤");
    const entry = entries.value[cursor.value]!;
    let reason = "";
    if (entry.kind === "rename") {
      reason = redoRename(entry);
      if (!reason) cursor.value++;
    } else if (entry.kind === "move") {
      reason = moveTo(doc.value.chapters, entry.chapterId, entry.redoAnchor)
        ? ""
        : "章节已不存在，无法重做排序";
      if (!reason) cursor.value++;
    } else {
      reason = redoDelete(entry);
      if (reason) return fail(reason);
    }
    if (reason) return fail(reason);
    note(`已重做：${entry.label}`);
    return { ok: true, message: "" };
  }

  /** 跳到某一步之后：点击“之后”步骤即回到该状态；点击“当前之前”的步骤则撤销到它之前。 */
  function gotoStep(id: string): PersistResult {
    const index = entries.value.findIndex((entry) => entry.id === id);
    if (index < 0) return fail("该历史步骤已不存在");
    const target = index + 1;
    let last: PersistResult = { ok: true, message: "" };
    while (cursor.value > target) {
      last = undo();
      if (!last.ok) return last;
    }
    while (cursor.value < target) {
      last = redo();
      if (!last.ok) return last;
    }
    note(`已定位到「${entries.value[index]?.label ?? ""}」之后的状态`);
    return last;
  }

  /** 回到最早的编辑之前（首步之前的状态）。 */
  function undoAll(): PersistResult {
    let last: PersistResult = { ok: true, message: "" };
    while (cursor.value > 0) {
      last = undo();
      if (!last.ok) return last;
    }
    note("已回到所有编辑之前的状态。");
    return last;
  }

  /* ---------- 存档快照 ---------- */

  function snapshotsAt(cur: number): SavedHistory[] {
    const all = entries.value;
    const safeCursor = Math.max(0, Math.min(cur, all.length));
    const build = (
      kept: HistoryEntry[],
      nextCursor: number,
      dropped: string[],
      grade: number,
    ): SavedHistory => ({
      version: 1,
      entries: kept,
      cursor: nextCursor,
      limit: limit.value,
      grade,
      moves: reader.moves.value,
      evictedCount: evictedCount.value,
      evictedLabels: [...evictedLabels.value],
      unavailableCount: dropped.length,
      unavailableLabels: [...new Set(dropped)].slice(-8),
    });
    const tombstone = (entry: HistoryEntry): HistoryEntry =>
      entry.kind === "delete" && entry.chapter
        ? { ...entry, chapter: null, payloadDropped: true }
        : entry;

    const out: SavedHistory[] = [build(all, safeCursor, [], 0)];

    // 档位 1：除最近一次已应用的删除外，其余删除只保留说明。
    let newestDelete = -1;
    for (let i = safeCursor - 1; i >= 0; i--)
      if (
        all[i]!.kind === "delete" &&
        (all[i] as DeleteHistoryEntry).chapter
      ) {
        newestDelete = i;
        break;
      }
    const dropped1: string[] = [];
    const kept1 = all.map((entry, index) => {
      if (index === newestDelete) return entry;
      if (entry.kind === "delete" && entry.chapter) {
        // 重做栈里的删除重做时用不到快照，不必算作“重开不可回退”。
        if (index < safeCursor) dropped1.push(entry.label);
        return tombstone(entry);
      }
      return entry;
    });
    if (dropped1.length) out.push(build(kept1, safeCursor, dropped1, 1));

    // 档位 2：丢掉最早一半已应用步骤。
    if (safeCursor > 1) {
      const dropN = Math.floor(safeCursor / 2);
      const dropped2 = all.slice(0, dropN).map((entry) => entry.label);
      const kept2 = all.slice(dropN).map((entry, offset) => {
        const original = dropN + offset;
        return original === newestDelete ? entry : tombstone(entry);
      });
      out.push(build(kept2, safeCursor - dropN, dropped2, 2));
    }

    // 档位 3：只保留最近 3 步已应用操作，重做栈放弃。
    if (all.length > 3 || safeCursor < all.length) {
      const keepFrom = Math.max(0, safeCursor - 3);
      const dropped3 = all.slice(0, keepFrom).map((entry) => entry.label);
      const kept3 = all.slice(keepFrom).map((entry, offset) => {
        const original = keepFrom + offset;
        return original === newestDelete ? entry : tombstone(entry);
      });
      out.push(build(kept3, safeCursor - keepFrom, dropped3, 3));
    }

    // 档位 4：只保留最近一步，保证重开后至少能撤销最后一步。
    if (safeCursor > 0) {
      const last = all[safeCursor - 1]!;
      const dropped4 = all
        .filter((_, index) => index !== safeCursor - 1)
        .map((entry) => entry.label);
      out.push(build([last], 1, dropped4, 4));
    }

    // 档位 5：只剩说明。
    out.push(build([], 0, all.map((entry) => entry.label), 5));
    return out;
  }

  function variants(): SavedHistory[] {
    return snapshotsAt(cursor.value);
  }

  function notePersisted(snapshot: SavedHistory | null) {
    // 存档彻底失败时本地仍是上一版存档：新步骤重开后会消失。
    if (!snapshot) {
      storageFailed.value = true;
      return;
    }
    storageFailed.value = false;
    const stored = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    const savedNext = new Set<string>();
    const riskNext = new Set<string>();
    entries.value.forEach((entry, index) => {
      const copy = stored.get(entry.id);
      if (copy) savedNext.add(entry.id);
      // 只有“已应用”的删除在重开后还需要快照来撤销；
      // 位于重做栈里的步骤重做时不依赖快照。
      const needsPayload =
        entry.kind === "delete" && entry.chapter && index < cursor.value;
      if (needsPayload && (!copy || (copy.kind === "delete" && !copy.chapter)))
        riskNext.add(entry.id);
    });
    savedIds.value = savedNext;
    atRisk.value = riskNext;
    unavailableCount.value = snapshot.unavailableCount;
    unavailableLabels.value = snapshot.unavailableLabels;
  }

  function setLimit(value: number) {
    limit.value = Math.max(
      100_000,
      Math.min(20_000_000, Math.round(Number(value) || DEFAULT_LIMIT)),
    );
    enforceLimit();
    deps.save?.();
  }

  function exportPending() {
    const current = pending.value;
    if (!current) return;
    const payload = {
      version: 1,
      kind: "panel-pending-restore",
      exportedAt: new Date().toISOString(),
      reason: current.reason,
      steps: current.steps,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `panel-pending-restore-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    note("待恢复内容已导出为 JSON 文件。");
  }

  function resetForDocumentChange() {
    entries.value = [];
    cursor.value = 0;
    evictedCount.value = 0;
    evictedLabels.value = [];
    savedIds.value = new Set();
    atRisk.value = new Set();
    storageFailed.value = false;
    unavailableCount.value = 0;
    unavailableLabels.value = [];
    pending.value = null;
    note("已切换漫画，原有编辑历史已清空。");
  }

  return {
    entries,
    cursor,
    limit,
    usage,
    rows,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    evictedCount,
    evictedLabels,
    unavailableCount,
    unavailableLabels,
    notice,
    pending,
    renameChapter,
    moveChapter,
    deleteChapter,
    undo,
    redo,
    gotoStep,
    undoAll,
    setLimit,
    clearNotice: () => {
      notice.value = "";
    },
    exportPending,
    dismissPending: () => {
      pending.value = null;
    },
    variants,
    notePersisted,
    resetForDocumentChange,
  };
}

export type HistoryRuntime = ReturnType<typeof useHistory>;
