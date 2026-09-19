import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MenuScreen } from "../types.ts";
import type {
  MenuKeybindings,
  MenuScreenComponent,
  MenuScreenComponentOptions,
} from "./contracts.ts";
import {
  actionMenuItemPresentation,
  actionMenuUnavailableDescription,
  handleSearchInput,
  renderFrameLayout,
  safeMenuText,
} from "./rendering.ts";

export type {
  MenuScreenComponent,
  MenuScreenComponentOptions,
  MenuScreenEvent,
} from "./contracts.ts";
export { actionMenuDialogLabel, safeMenuText } from "./rendering.ts";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export function createMenuScreenComponent<ScreenId extends string, ActionId extends string>(
  options: MenuScreenComponentOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  let component: MenuScreenComponent;
  switch (options.screen.kind) {
    case "actions":
      component = createActionsComponent(options as ActionsOptions<ScreenId, ActionId>);
      break;
    case "choice":
      component = createChoiceComponent(options as ChoiceOptions<ScreenId, ActionId>);
      break;
    default:
      throw new Error("unsupported menu screen kind");
  }
  Object.defineProperty(component, "__piTuiKitScreen", { value: true });
  return component;
}

type ActionsOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
  ScreenId,
  ActionId
> & {
  screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "actions" }>;
};
type ChoiceOptions<ScreenId extends string, ActionId extends string> = MenuScreenComponentOptions<
  ScreenId,
  ActionId
> & {
  screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "choice" }>;
};
function createActionsComponent<ScreenId extends string, ActionId extends string>(
  options: ActionsOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  const items: SelectItem[] = options.screen.items.map((item) => ({
    value: item.id,
    ...actionMenuItemPresentation(item),
  }));
  const widestPrimary = Math.max(1, ...items.map((item) => visibleWidth(item.label))) + 2;
  const list = new SelectList(items, Math.min(items.length, 10), selectTheme(options.theme), {
    minPrimaryColumnWidth: Math.min(32, widestPrimary),
    maxPrimaryColumnWidth: widestPrimary,
    truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, maxWidth > 1 ? "…" : ""),
  });
  setInitialSelection(list, items, options.selectedItemId);
  return commonListComponent(
    options,
    list,
    items,
    options.screen.lines ?? [],
    options.screen.hint ?? "back",
    (itemId) => {
      const source = options.screen.items.find((candidate) => candidate.id === itemId);
      if (!source?.disabled) options.onEvent({ kind: "activate", itemId });
    },
    (itemId) => {
      const source = options.screen.items.find((candidate) => candidate.id === itemId);
      if (!source) return [];
      const unavailable = actionMenuUnavailableDescription(source);
      return unavailable ? [unavailable] : [];
    },
  );
}

function createChoiceComponent<ScreenId extends string, ActionId extends string>(
  options: ChoiceOptions<ScreenId, ActionId>,
): MenuScreenComponent {
  const searchInput = new Input();
  const restoredSearchQuery = options.searchQuery ?? "";
  if (restoredSearchQuery) handleSearchInput(searchInput, restoredSearchQuery);
  const allItems = options.screen.items.map((item) => {
    const current = item.id === options.screen.currentItemId ? " ✓ current" : "";
    const unavailable = item.disabled
      ? `unavailable${item.disabledReason ? `: ${safeMenuText(item.disabledReason)}` : ""}`
      : undefined;
    const label = safeMenuText(item.label);
    const description = item.description ? safeMenuText(item.description) : "";
    return {
      item,
      selectItem: {
        value: item.id,
        label: `${item.disabled ? "[-] " : ""}${label}${current}`,
        description:
          [unavailable, description].filter((value): value is string => Boolean(value)).join(" · ") || undefined,
      } as SelectItem,
      searchText: [
        safeChoiceText(item.label),
        safeChoiceText(item.description ?? ""),
        safeChoiceText(item.searchText ?? ""),
      ]
        .filter(Boolean)
        .join(" "),
    };
  });
  let filteredItems = options.screen.enableSearch
    ? fuzzyFilter(allItems, searchInput.getValue(), (candidate) => candidate.searchText)
    : [...allItems];
  let selectedIndex = Math.max(
    0,
    filteredItems.findIndex(({ item }) => item.id === options.selectedItemId),
  );
  let restoreItemId: string | undefined;
  let disposed = false;
  let searchPasteActive = false;
  let searchPasteEndPrefix = "";
  let mousePressedIndex: number | undefined;
  let mouseLayout: ListMouseLayout | undefined;
  let list = createList();

  function pageSize() {
    return Math.min(filteredItems.length, options.screen.viewportSize ?? 10);
  }
  function createList() {
    const items = filteredItems.map(({ selectItem }) => selectItem);
    const next = new SelectList(
      items,
      Math.min(items.length, options.screen.viewportSize ?? 10),
      selectTheme(options.theme),
    );
    setInitialSelection(next, items, filteredItems[selectedIndex]?.item.id);
    return next;
  }
  const selected = () => filteredItems[selectedIndex]?.item;
  const setSelectedIndex = (index: number, wrap: boolean, rememberUserSelection: boolean) => {
    if (filteredItems.length === 0) {
      selectedIndex = 0;
      return;
    }
    selectedIndex = wrap
      ? (index + filteredItems.length) % filteredItems.length
      : Math.max(0, Math.min(index, filteredItems.length - 1));
    if (rememberUserSelection) restoreItemId = undefined;
    list.setSelectedIndex(selectedIndex);
    const item = selected();
    if (item) options.onSelectionChange?.(item.id);
  };
  const move = (delta: number) => setSelectedIndex(selectedIndex + delta, true, true);
  const applyFilter = () => {
    if (!options.screen.enableSearch) return;
    mousePressedIndex = undefined;
    const previouslySelectedId = selected()?.id;
    filteredItems = fuzzyFilter(allItems, searchInput.getValue(), (candidate) => candidate.searchText);
    if (filteredItems.length === 0) {
      if (previouslySelectedId) restoreItemId ??= previouslySelectedId;
      selectedIndex = 0;
      list = createList();
      return;
    }
    const previousIndex = filteredItems.findIndex(({ item }) => item.id === previouslySelectedId);
    if (previousIndex < 0 && previouslySelectedId) restoreItemId ??= previouslySelectedId;
    const restoreIndex = filteredItems.findIndex(({ item }) => item.id === restoreItemId);
    selectedIndex = restoreIndex >= 0 ? restoreIndex : previousIndex >= 0 ? previousIndex : 0;
    if (restoreIndex >= 0) restoreItemId = undefined;
    list = createList();
    const item = selected();
    if (item) options.onSelectionChange?.(item.id);
  };
  const activate = () => {
    const item = selected();
    if (!item || item.disabled) return false;
    options.onEvent({ kind: "activate", itemId: item.id });
    return true;
  };
  const applySearchInput = (data: string) => {
    handleSearchInput(searchInput, data);
    options.onSearchQueryChange?.(searchInput.getValue());
    applyFilter();
  };
  const dispatchNonPasteInput = (data: string) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      options.onEvent({ kind: "close" });
      return true;
    }
    if (options.keybindings.matches(data, "tui.select.cancel")) {
      options.onEvent({ kind: options.screen.hint ?? "back" });
      return true;
    }
    if (options.keybindings.matches(data, "tui.select.up")) move(-1);
    else if (options.keybindings.matches(data, "tui.select.down")) move(1);
    else if (options.keybindings.matches(data, "tui.select.pageUp")) {
      setSelectedIndex(selectedIndex - Math.max(1, pageSize()), false, true);
    } else if (options.keybindings.matches(data, "tui.select.pageDown")) {
      setSelectedIndex(selectedIndex + Math.max(1, pageSize()), false, true);
    } else if (matchesKey(data, Key.home)) setSelectedIndex(0, false, true);
    else if (matchesKey(data, Key.end)) {
      setSelectedIndex(filteredItems.length - 1, false, true);
    } else if (
      options.keybindings.matches(data, "tui.select.confirm") ||
      (!options.screen.enableSearch && data === " ")
    ) {
      return activate();
    } else if (options.screen.enableSearch) applySearchInput(data);
    return false;
  };
  const dispatchInput = (data: string) => {
    let remaining = data;
    while (remaining) {
      if (!options.screen.enableSearch) {
        dispatchNonPasteInput(remaining);
        return;
      }
      if (searchPasteActive) {
        const prefix = searchPasteEndPrefix;
        const combined = prefix + remaining;
        const end = combined.indexOf(BRACKETED_PASTE_END);
        const consumed = end < 0 ? remaining.length : Math.max(0, end + BRACKETED_PASTE_END.length - prefix.length);
        const pasteChunk = remaining.slice(0, consumed);
        if (pasteChunk) applySearchInput(pasteChunk);
        if (end < 0) {
          const prefixLength = trailingMarkerPrefixLength(combined, BRACKETED_PASTE_END);
          searchPasteEndPrefix = prefixLength > 0 ? combined.slice(-prefixLength) : "";
          return;
        }
        searchPasteActive = false;
        searchPasteEndPrefix = "";
        remaining = remaining.slice(consumed);
        continue;
      }
      const start = remaining.indexOf(BRACKETED_PASTE_START);
      if (start < 0) {
        dispatchNonPasteInput(remaining);
        return;
      }
      if (start > 0 && dispatchNonPasteInput(remaining.slice(0, start))) return;
      searchPasteActive = true;
      searchPasteEndPrefix = "";
      remaining = remaining.slice(start);
    }
  };
  const component: MenuScreenComponent & Partial<Focusable> = {
    render(width) {
      const safeWidth = Math.max(1, width);
      const selectedItem = selected();
      const details = [
        ...(selectedItem?.disabledReason ? [`Unavailable: ${safeMenuText(selectedItem.disabledReason)}`] : []),
        ...(selectedItem?.details ?? []).map(safeMenuText),
      ];
      const detailRows = details.flatMap((line) => wrapTextWithAnsi(options.theme.fg("muted", line), safeWidth));
      const choices =
        allItems.length === 0
          ? [options.theme.fg("dim", "  No choices available")]
          : filteredItems.length === 0
            ? [options.theme.fg("dim", "  No matching choices")]
            : [...list.render(safeWidth), ...(detailRows.length > 0 ? ["", ...detailRows] : [])];
      const search = options.screen.enableSearch
        ? [
            ...renderChoiceSearchInput(searchInput, safeWidth),
            "",
            ...choices,
            ...(filteredItems.length > 0 ? [options.theme.fg("dim", "Type to search")] : []),
          ]
        : choices;
      const frame = renderFrameLayout(
        options.screen.title,
        options.screen.lines ?? [],
        search,
        options.screen.hint ?? "back",
        safeWidth,
        options,
        {
          compactOverflowText:
            filteredItems.length > 1 ? `  (${selectedIndex + 1}/${filteredItems.length})` : undefined,
          confirmAction: "select",
          pinnedContentRows: options.screen.enableSearch ? 1 : 0,
          priorityTailRows: detailRows.length + (options.screen.enableSearch ? 1 : 0),
        },
      );
      const listContentStart = options.screen.enableSearch ? 2 : 0;
      const visibleCount = Math.min(filteredItems.length, options.screen.viewportSize ?? 10);
      const viewportStart = listWindowStart(selectedIndex, filteredItems.length, visibleCount);
      mouseLayout = {
        width: safeWidth,
        inputFrameRow: options.screen.enableSearch ? frameRowForContent(frame, 0) : undefined,
        itemByFrameRow: itemRowsForFrame(frame, listContentStart, viewportStart, visibleCount),
      };
      return frame.lines;
    },
    invalidate() {
      mouseLayout = undefined;
      list.invalidate();
      if (options.screen.enableSearch) searchInput.invalidate();
    },
    handleInput(data) {
      if (disposed) return;
      mousePressedIndex = undefined;
      dispatchInput(data);
      options.tui.requestRender();
    },
    handleMouse(event) {
      if (disposed) return undefined;
      const inputResult = routeInputMouse(searchInput, event, mouseLayout, options.screen.enableSearch ? 8 : 0);
      if (inputResult) return inputResult;
      return routeListMouse(event, mouseLayout, {
        selectedIndex,
        itemCount: filteredItems.length,
        onSelect: (index) => setSelectedIndex(index, false, true),
        onActivate: activate,
        getPressedIndex: () => mousePressedIndex,
        setPressedIndex: (index) => {
          mousePressedIndex = index;
        },
      });
    },
    async waitForPending() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      searchPasteActive = false;
      searchPasteEndPrefix = "";
      mousePressedIndex = undefined;
      mouseLayout = undefined;
      options.onDispose?.();
    },
  };
  if (options.screen.enableSearch) {
    Object.defineProperty(component, "focused", {
      get: () => searchInput.focused,
      set: (value: boolean) => {
        searchInput.focused = value;
      },
    });
  }
  return component;
}

function trailingMarkerPrefixLength(value: string, marker: string) {
  for (let length = Math.min(value.length, marker.length - 1); length > 0; length -= 1) {
    if (marker.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

function safeChoiceText(value: unknown): string {
  return safeMenuText(stripVTControlCharacters(String(value)));
}

function renderChoiceSearchInput(input: Input, width: number): string[] {
  const prefix = "Search: ";
  const inputWidth = Math.max(1, width - visibleWidth(prefix));
  return input.render(inputWidth).map((line) => truncateToWidth(`${prefix}${line}`, width, ""));
}

interface ListMouseLayout {
  width: number;
  inputFrameRow?: number;
  itemByFrameRow: ReadonlyMap<number, number>;
}

interface FrameContentLayout {
  contentRows: readonly { contentIndex: number; frameIndex: number }[];
}

interface ListMouseActions {
  selectedIndex: number;
  itemCount: number;
  onSelect(index: number): void;
  onActivate(): void;
  getPressedIndex(): number | undefined;
  setPressedIndex(index: number | undefined): void;
}

function frameRowForContent(frame: FrameContentLayout, contentIndex: number) {
  return frame.contentRows.find((row) => row.contentIndex === contentIndex)?.frameIndex;
}

function itemRowsForFrame(
  frame: FrameContentLayout,
  contentStart: number,
  viewportStart: number,
  visibleCount: number,
) {
  return new Map(
    Array.from({ length: visibleCount }, (_, offset) => {
      const frameRow = frameRowForContent(frame, contentStart + offset);
      return frameRow === undefined ? undefined : ([frameRow, viewportStart + offset] as const);
    }).filter((entry): entry is readonly [number, number] => entry !== undefined),
  );
}

function listWindowStart(selectedIndex: number, itemCount: number, viewportSize: number) {
  if (itemCount <= viewportSize) return 0;
  return Math.max(0, Math.min(selectedIndex - Math.floor(viewportSize / 2), itemCount - viewportSize));
}

function routeInputMouse(
  input: Input,
  event: TuiMouseEvent,
  layout: ListMouseLayout | undefined,
  xOffset: number,
): TuiMouseEventResult | undefined {
  if (!layout || event.width !== layout.width || event.y !== layout.inputFrameRow) return undefined;
  const inputWidth = Math.max(1, layout.width - xOffset);
  if (event.x < xOffset || event.x >= xOffset + inputWidth) return undefined;
  return input.handleMouse({ ...event, x: event.x - xOffset, y: 0, width: inputWidth, height: 1 });
}

function routeListMouse(
  event: TuiMouseEvent,
  layout: ListMouseLayout | undefined,
  actions: ListMouseActions,
): TuiMouseEventResult | undefined {
  if (!layout || event.width !== layout.width || actions.itemCount === 0) return undefined;
  const mappedIndex = layout.itemByFrameRow.get(event.y);
  if (mappedIndex === undefined) return undefined;
  const itemIndex = event.type === "click" ? (actions.getPressedIndex() ?? mappedIndex) : mappedIndex;
  if (itemIndex < 0 || itemIndex >= actions.itemCount) return undefined;
  if (event.type === "wheel" && event.wheelDelta) {
    const next = Math.max(0, Math.min(actions.itemCount - 1, actions.selectedIndex + (event.wheelDelta < 0 ? -1 : 1)));
    const changed = next !== actions.selectedIndex;
    if (changed) actions.onSelect(next);
    return { handled: true, render: changed };
  }
  if (event.type === "move") return { handled: true };
  if (event.button !== "left") return undefined;
  if (event.type === "press") {
    actions.setPressedIndex(itemIndex);
    const changed = itemIndex !== actions.selectedIndex;
    if (changed) actions.onSelect(itemIndex);
    return { handled: true, focus: true, render: changed };
  }
  if (event.type === "click") {
    actions.setPressedIndex(undefined);
    if (itemIndex !== actions.selectedIndex) actions.onSelect(itemIndex);
    actions.onActivate();
    return { handled: true };
  }
  return undefined;
}

function commonListComponent<ScreenId extends string, ActionId extends string>(
  options: MenuScreenComponentOptions<ScreenId, ActionId>,
  list: SelectList,
  items: readonly SelectItem[],
  lines: readonly string[],
  destination: "back" | "close",
  onActivate: (itemId: string) => void,
  selectedDetails?: (itemId: string) => readonly string[],
): MenuScreenComponent {
  const initialIndex = Math.max(
    0,
    items.findIndex((item) => item.value === options.selectedItemId),
  );
  let selectedIndex = initialIndex;
  let disposed = false;
  let mousePressedIndex: number | undefined;
  let mouseLayout: ListMouseLayout | undefined;
  const select = (index: number, wrap: boolean) => {
    if (items.length === 0) return;
    selectedIndex = wrap ? (index + items.length) % items.length : Math.max(0, Math.min(index, items.length - 1));
    list.setSelectedIndex(selectedIndex);
    const itemId = items[selectedIndex]?.value;
    if (itemId) options.onSelectionChange?.(itemId);
  };
  return {
    render(width) {
      const safeWidth = Math.max(1, width);
      const selectedId = items[selectedIndex]?.value;
      const details = selectedId ? (selectedDetails?.(selectedId) ?? []) : [];
      const detailRows = details.flatMap((detail) =>
        wrapTextWithAnsi(options.theme.fg("muted", safeMenuText(detail)), safeWidth),
      );
      const content = [...list.render(safeWidth), ...(detailRows.length > 0 ? ["", ...detailRows] : [])];
      const frame = renderFrameLayout(options.screen.title, lines, content, destination, width, options, {
        compactOverflowText: items.length > 1 ? `  (${selectedIndex + 1}/${items.length})` : undefined,
        priorityTailRows: detailRows.length,
      });
      const visibleCount = Math.min(items.length, 10);
      mouseLayout = {
        width: safeWidth,
        itemByFrameRow: itemRowsForFrame(
          frame,
          0,
          listWindowStart(selectedIndex, items.length, visibleCount),
          visibleCount,
        ),
      };
      return frame.lines;
    },
    invalidate() {
      mouseLayout = undefined;
      list.invalidate();
    },
    handleInput(data) {
      if (disposed) return;
      mousePressedIndex = undefined;
      if (matchesKey(data, Key.ctrl("c"))) {
        options.onEvent({ kind: "close" });
        return;
      }
      if (options.keybindings.matches(data, "tui.select.cancel")) {
        options.onEvent({ kind: destination });
        return;
      }
      if (options.keybindings.matches(data, "tui.select.up")) select(selectedIndex - 1, true);
      else if (options.keybindings.matches(data, "tui.select.down")) {
        select(selectedIndex + 1, true);
      } else if (options.keybindings.matches(data, "tui.select.pageUp")) {
        select(selectedIndex - Math.max(1, Math.min(items.length, 10)), false);
      } else if (options.keybindings.matches(data, "tui.select.pageDown")) {
        select(selectedIndex + Math.max(1, Math.min(items.length, 10)), false);
      } else if (matchesKey(data, Key.home)) select(0, false);
      else if (matchesKey(data, Key.end)) select(items.length - 1, false);
      else if (options.keybindings.matches(data, "tui.select.confirm")) {
        const itemId = items[selectedIndex]?.value;
        if (itemId) onActivate(itemId);
      }
      options.tui.requestRender();
    },
    handleMouse(event) {
      if (disposed) return undefined;
      return routeListMouse(event, mouseLayout, {
        selectedIndex,
        itemCount: items.length,
        onSelect: (index) => select(index, false),
        onActivate: () => {
          const itemId = items[selectedIndex]?.value;
          if (itemId) onActivate(itemId);
        },
        getPressedIndex: () => mousePressedIndex,
        setPressedIndex: (index) => {
          mousePressedIndex = index;
        },
      });
    },
    async waitForPending() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      mousePressedIndex = undefined;
      mouseLayout = undefined;
      options.onDispose?.();
    },
  };
}

function selectTheme(theme: Pick<Theme, "fg">) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

function setInitialSelection(list: SelectList, items: readonly SelectItem[], selectedId?: string) {
  if (!selectedId) return;
  const index = items.findIndex((item) => item.value === selectedId);
  if (index >= 0) list.setSelectedIndex(index);
}
