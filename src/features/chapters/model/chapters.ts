import { ref } from "vue";
import type { HistoryRuntime } from "../../history";
export function useChapters(history: HistoryRuntime) {
  const editing = ref(""),
    draft = ref(""),
    error = ref("");
  function begin(id: string, current: string) {
    editing.value = id;
    draft.value = current;
    error.value = "";
  }
  function rename() {
    const result = history.renameChapter(editing.value, draft.value);
    if (!result.ok) {
      error.value = result.message;
      return;
    }
    editing.value = "";
    error.value = "";
  }
  function move(id: string, delta: number) {
    const result = history.moveChapter(id, delta);
    error.value = result.ok ? "" : result.message;
  }
  function remove(id: string) {
    const result = history.deleteChapter(id);
    error.value = result.ok ? "" : result.message;
  }
  return { editing, draft, error, begin, rename, move, remove };
}
