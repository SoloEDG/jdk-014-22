import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import { demoDocument, useLibrary } from "../features/library";
import { useChapters } from "../features/chapters";
import { useReader } from "../features/reader";
import { useAudio } from "../features/audio";
import { useProgress, readSession } from "../features/progress";
import { useHistory } from "../features/history";
export function useWorkspace() {
  const saved = readSession(),
    doc = ref(saved?.document ?? demoDocument()),
    reader = useReader(doc);
  if (saved) reader.dispatch({ type: "restore", location: saved.location });

  const progress = useProgress(doc, reader.location, saved);
  const history = useHistory(
    doc,
    reader,
    {
      bookmarks: () => progress.bookmarks.value,
      setBookmarks: (next) => progress.setBookmarks(next),
      sync: () => {
        reader.reconcile();
        progress.reconcile();
      },
      persist: (session, variants) => progress.persist(session, variants),
      save: () => progress.save(),
    },
    saved?.history,
  );
  // 自动保存时一并写入历史记录（必要时逐级压缩）。
  progress.attach({
    variants: history.variants,
    persisted: history.notePersisted,
  });

  const library = useLibrary(doc, (id) => {
    reader.dispatch({ type: "chapter", id });
    progress.reconcile();
  });
  // 打开内置漫画会替换整本文档，旧历史失去意义。
  const openDemo = () => {
    history.resetForDocumentChange();
    library.reset();
  };

  const chapters = useChapters(history),
    panel = computed(() => reader.current.value.panel),
    audio = useAudio(panel);

  function keydown(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.closest("input,textarea,button,select"))
      return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
      return;
    }
    if (mod && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      history.redo();
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      reader.dispatch({ type: "move", delta: e.key === "ArrowRight" ? 1 : -1 });
    }
    if (e.key === " ") {
      e.preventDefault();
      audio.toggle();
    }
    if (e.key === "Escape") reader.setMode("page");
  }
  onMounted(() => window.addEventListener("keydown", keydown));
  onBeforeUnmount(() => window.removeEventListener("keydown", keydown));

  return {
    doc,
    reader,
    progress,
    library,
    chapters,
    audio,
    history,
    openDemo,
  };
}
