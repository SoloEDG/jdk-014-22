import { ref, computed, type Ref } from "vue";
import type {
  ComicDocument,
  ReadingLocation,
  ReadingMode,
} from "../../../shared/document";
import type { ReaderCommand } from "../../../shared/commands";
import { firstLocation, resolveLocation } from "../../../shared/lookup";
import { normalize, advance } from "../lib/navigation";
import { constrainPan } from "../lib/viewport";
export function useReader(doc: Ref<ComicDocument>) {
  const location = ref<ReadingLocation>(firstLocation(doc.value)),
    mode = ref<ReadingMode>("page");
  /** 用户手动导航的次数；恢复、对齐、缩放平移都不计入。 */
  const moves = ref(0);
  const current = computed(() => resolveLocation(doc.value, location.value));
  function dispatch(command: ReaderCommand) {
    let at = { ...location.value };
    if (command.type === "move") {
      at = advance(doc.value, at, command.delta, mode.value);
      moves.value++;
    }
    if (command.type === "chapter") {
      const c = doc.value.chapters.find((c) => c.id === command.id);
      at = {
        chapterId: c?.id ?? "",
        pageId: c?.pages[0]?.id ?? "",
        panelId: c?.pages[0]?.panels[0]?.id ?? "",
        zoom: 1,
        x: 0,
        y: 0,
      };
      moves.value++;
    }
    if (command.type === "panel") {
      moves.value++;
      at.panelId = command.id;
      at.zoom = 1;
      at.x = at.y = 0;
    }
    if (command.type === "restore") at = { ...command.location };
    if (command.type === "jump") {
      moves.value++;
      at = { ...command.location };
    }
    location.value = normalize(doc.value, at);
  }
  function reconcile() {
    location.value = normalize(doc.value, location.value);
  }
  function zoom(delta: number) {
    location.value.zoom = Math.max(
      1,
      Math.min(3, Math.round((location.value.zoom + delta) * 10) / 10),
    );
    Object.assign(
      location.value,
      constrainPan(location.value.x, location.value.y, location.value.zoom),
    );
  }
  function pan(x: number, y: number) {
    Object.assign(location.value, constrainPan(x, y, location.value.zoom));
  }
  function setMode(value: ReadingMode) {
    mode.value = value;
  }
  return {
    location,
    mode,
    moves,
    current,
    dispatch,
    reconcile,
    zoom,
    pan,
    setMode,
  };
}
