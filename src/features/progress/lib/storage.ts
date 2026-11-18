import type {
  Bookmark,
  ComicDocument,
  ReadingLocation,
} from "../../../shared/document";
import type { SavedHistory } from "../../history/lib/types";

const KEY = "panel-jdk014-v1";

export interface SavedSession {
  document: ComicDocument;
  location: ReadingLocation;
  bookmarks: Bookmark[];
  /** 章节编辑历史；旧版存档没有这个字段。 */
  history?: SavedHistory;
}

export interface SaveOutcome {
  ok: boolean;
  saved: SavedSession | null;
  message: string;
}

function validHistory(value: unknown): SavedHistory | null {
  if (!value || typeof value !== "object") return null;
  const history = value as Partial<SavedHistory>;
  if (history.version !== 1 || !Array.isArray(history.entries)) return null;
  const entries = history.entries.filter(
    (entry) =>
      entry &&
      typeof entry.id === "string" &&
      typeof entry.label === "string" &&
      (entry.kind === "rename" ||
        entry.kind === "move" ||
        entry.kind === "delete"),
  );
  const cursor = Math.max(
    0,
    Math.min(entries.length, Number(history.cursor) || 0),
  );
  return {
    version: 1,
    entries,
    cursor,
    limit: Math.max(100_000, Number(history.limit) || 3_000_000),
    grade: Math.max(0, Number(history.grade) || 0),
    moves: Math.max(0, Number(history.moves) || 0),
    evictedCount: Math.max(0, Number(history.evictedCount) || 0),
    evictedLabels: Array.isArray(history.evictedLabels)
      ? history.evictedLabels.filter(
          (label): label is string => typeof label === "string",
        )
      : [],
    unavailableCount: Math.max(0, Number(history.unavailableCount) || 0),
    unavailableLabels: Array.isArray(history.unavailableLabels)
      ? history.unavailableLabels.filter(
          (label): label is string => typeof label === "string",
        )
      : [],
  };
}

export function readSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as SavedSession;
    if (
      value.document?.version !== 1 ||
      !Array.isArray(value.document.chapters) ||
      !value.document.chapters.length ||
      !value.location ||
      !Array.isArray(value.bookmarks)
    )
      return null;
    for (const c of value.document.chapters) {
      if (!c.pages?.length) return null;
      for (const p of c.pages)
        if (!p.panels?.length || typeof p.image !== "string") return null;
    }
    const history = validHistory(value.history);
    return {
      document: value.document,
      location: value.location,
      bookmarks: value.bookmarks,
      ...(history ? { history } : {}),
    };
  } catch {
    return null;
  }
}

export function formatMessage(value: SavedSession): string {
  const history = value.history;
  if (!history) return "已保存到此浏览器";
  if (history.grade === 0 && history.unavailableCount === 0)
    return "已保存到此浏览器";
  if (history.unavailableCount > 0)
    return `已保存；为节省空间，省略了 ${history.unavailableCount} 步历史，重开后不可回退`;
  return "已保存；历史记录已压缩以节省空间";
}

/**
 * 依次尝试多个候选会话（历史压缩程度从高到低）。
 * 只有 setItem 成功才返回成功，失败时本地原有存档保持不变。
 */
export function writeSessions(candidates: SavedSession[]): SaveOutcome {
  if (!candidates.length)
    return { ok: false, saved: null, message: "没有可保存的内容" };
  let failure = "";
  for (const candidate of candidates) {
    try {
      localStorage.setItem(KEY, JSON.stringify(candidate));
      return { ok: true, saved: candidate, message: formatMessage(candidate) };
    } catch (error) {
      failure =
        error instanceof Error && error.name === "QuotaExceededError"
          ? "quota"
          : "error";
    }
  }
  return {
    ok: false,
    saved: null,
    message:
      failure === "quota"
        ? "存储空间不足，本次修改仅保留在当前页面；请减少导入图片或调低历史占用"
        : "本地存储不可用，本次修改仅保留在当前页面",
  };
}
