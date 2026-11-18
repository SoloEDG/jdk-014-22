import type {
  Bookmark,
  Chapter,
  ComicDocument,
  ReadingLocation,
} from "../../../shared/document";
import type { LostStep } from "../../../shared/commands";

export type { LostStep };

export type HistoryKind = "rename" | "move" | "delete";

/** 章节在数组中的邻接锚点，避免导入等操作改动下标后恢复错位。 */
export interface OrderAnchor {
  prevId: string | null;
  nextId: string | null;
  index: number;
}

interface HistoryBase {
  id: string;
  at: number;
  label: string;
  locationBefore: ReadingLocation;
  locationAfter: ReadingLocation;
  /** 应用这一步之后，用户手动导航的累计次数。 */
  movesAfter?: number;
  /** 序列化后的近似体积（UTF-16 码元），用于限制历史占用。 */
  size: number;
}

export interface RenameHistoryEntry extends HistoryBase {
  kind: "rename";
  chapterId: string;
  before: string;
  after: string;
}

export interface MoveHistoryEntry extends HistoryBase {
  kind: "move";
  chapterId: string;
  title: string;
  from: number;
  to: number;
  /** 撤销时按此锚点放回。 */
  undoAnchor: OrderAnchor;
  /** 重做时按此锚点放回。 */
  redoAnchor: OrderAnchor;
}

export interface RemovedBookmark {
  /** 删除前在书签数组中的位置。 */
  index: number;
  bookmark: Bookmark;
}

export interface DeleteHistoryEntry extends HistoryBase {
  kind: "delete";
  chapterId: string;
  /** 删除前的章节下标。 */
  index: number;
  anchor: OrderAnchor;
  /** 章节快照（页面、分镜对白、声音）。空间不足时可能只剩标记。 */
  chapter: Chapter | null;
  /** 随章节一起被移走的书签。 */
  bookmarks: RemovedBookmark[];
  /** 这一步是否真的改变了阅读位置（删的是当前章节）。 */
  locationTouched: boolean;
  /** 撤销这一步之后，用户手动导航的累计次数。 */
  movesAfterUndo?: number;
  payloadDropped?: boolean;
}

export type HistoryEntry =
  | RenameHistoryEntry
  | MoveHistoryEntry
  | DeleteHistoryEntry;

export type NewHistoryEntry =
  | Omit<RenameHistoryEntry, "id" | "at" | "size">
  | Omit<MoveHistoryEntry, "id" | "at" | "size">
  | Omit<DeleteHistoryEntry, "id" | "at" | "size">;

export interface SavedHistory {
  version: 1;
  entries: HistoryEntry[];
  cursor: number;
  /** 历史记录占用上限（UTF-16 码元）。 */
  limit: number;
  /** 0–4：存档时为了节省空间采用的压缩档位，越大信息越少。 */
  grade: number;
  /** 存档时用户手动导航的累计次数，重开后继续累加。 */
  moves?: number;
  /** 历史上因内存上限被彻底移出的步骤数量。 */
  evictedCount: number;
  /** 最近被移出的步骤名称。 */
  evictedLabels: string[];
  /** 本次存档没能一起保存、重开后不可回退的步骤数量。 */
  unavailableCount: number;
  /** 这些步骤的名称。 */
  unavailableLabels: string[];
}

export interface HistoryItemView {
  id: string;
  label: string;
  at: number;
  kind: HistoryKind;
  index: number;
  applied: boolean;
  /** 只在本次会话可撤销/重做，重开后不存在。 */
  sessionOnly: boolean;
  /** 本次保存后，重开时该步骤只剩说明、无法回退。 */
  payloadAtRisk: boolean;
  /** 非空表示该步骤当前无法再撤销/重做，值为原因。 */
  blockedReason: string;
}

export interface PendingStep {
  label: string;
  kind: HistoryKind;
  at: number;
  chapter?: Chapter;
  bookmarks?: Bookmark[];
}

/** 恢复空间不足时保留的待恢复内容，可导出为 JSON。 */
export interface PendingRestore {
  reason: string;
  at: number;
  steps: PendingStep[];
}

export interface PersistSession {
  document: ComicDocument;
  location: ReadingLocation;
  bookmarks: Bookmark[];
}

export interface PersistOutcome {
  ok: boolean;
  /** 实际写入的历史快照；null 表示只保存了文档，历史未能写入。 */
  snapshot: SavedHistory | null;
  message: string;
}

export interface PersistResult {
  ok: boolean;
  message: string;
}

export interface ReaderLike {
  location: { value: ReadingLocation };
  /** 用户手动导航的累计次数；用于判断某一步之后位置是否被人为挪动。 */
  moves: { value: number };
  dispatch(command: import("../../../shared/commands").ReaderCommand): void;
  reconcile(): void;
}
