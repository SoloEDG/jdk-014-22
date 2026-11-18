import type { ReadingLocation } from "./document";
export type ReaderCommand =
  | { type: "chapter"; id: string }
  | { type: "move"; delta: number }
  | { type: "panel"; id: string }
  | { type: "restore"; location: ReadingLocation }
  /** 用户主动跳转（如点书签）：等同于 restore，但计入手动导航。 */
  | { type: "jump"; location: ReadingLocation };
export interface Notice {
  text: string;
  tone: "success" | "error";
}
export interface LostStep {
  id: string;
  label: string;
}
export interface PersistResult {
  ok: boolean;
  message: string;
  /** 这一步写入本地存储时，哪些历史步骤没能一起保存。 */
  unavailable?: LostStep[];
}
export const makeId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
