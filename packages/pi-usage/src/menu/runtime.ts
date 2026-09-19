import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  actionMenuDialogLabel,
  createMenuScreenComponent,
  type MenuScreenComponent,
  type MenuScreenEvent,
  safeMenuText,
} from "./components/index.ts";
import {
  invokeMenuInteraction,
  isMenuCurrent,
  type MenuInteraction,
  reportMenuError,
} from "./interaction.ts";
import { resolveMenuScreen } from "./model.ts";
import { createMenuNavigator } from "./navigator.ts";
import type {
  ChoiceScreen,
  MenuChoiceItem,
  MenuCloseReason,
  MenuContext,
  MenuDefinition,
  MenuScreen,
  MenuTransition,
} from "./types.ts";

type ExtensionMode = MenuContext["mode"];

export type RunMenuResult =
  | { kind: "closed"; reason: MenuCloseReason }
  | { kind: "stale" }
  | { kind: "unsupported"; mode: ExtensionMode }
  | { kind: "error"; error: unknown };

export interface RunMenuOptions<State, Context extends MenuContext = ExtensionCommandContext> {
  getState(context: { ctx: Context; signal: AbortSignal }): State | Promise<State>;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  onError?(ctx: Context, error: unknown): void | Promise<void>;
  onUnsupportedMode?(ctx: Context, mode: ExtensionMode): void | Promise<void>;
}

type InternalScreenEvent<ScreenId extends string> =
  | MenuScreenEvent
  | { kind: "transition"; transition: MenuTransition<ScreenId> };

export async function runMenu<
  State,
  ScreenId extends string,
  ActionId extends string,
  Context extends MenuContext = ExtensionCommandContext,
>(
  ctx: Context,
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
  options: RunMenuOptions<State, Context>,
): Promise<RunMenuResult> {
  if (ctx.mode === "tui" && ctx.hasUI) return runTuiMenu(ctx, definition, options);
  if (ctx.mode === "rpc" && ctx.hasUI) return runDialogMenu(ctx, definition, options);
  await options.onUnsupportedMode?.(ctx, ctx.mode);
  return { kind: "unsupported", mode: ctx.mode };
}

async function runTuiMenu<State, ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  ctx: Context,
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
  options: RunMenuOptions<State, Context>,
): Promise<RunMenuResult> {
  const menuController = new AbortController();
  const menuSignal = options.signal ? AbortSignal.any([menuController.signal, options.signal]) : menuController.signal;
  const navigator = createMenuNavigator(definition.start);
  const searchQueries = new Map<ScreenId, string>();
  try {
    while (!navigator.closed) {
      const loaded = await loadState(ctx, options, menuSignal);
      if (loaded.kind !== "loaded") return loaded.result;
      const state = loaded.state;
      const screenId = navigator.current;
      const screen = resolveMenuScreen(definition, screenId, state);
      let staleAction = false;
      const interact = async (interaction: MenuInteraction, interactionSignal?: AbortSignal) => {
        const invocation = await invokeMenuInteraction({
          ctx,
          definition,
          screen,
          state,
          menuSignal,
          interactionSignal,
          runtime: options,
          interaction,
        });
        if (invocation.selectionItemId) {
          navigator.rememberSelection(navigator.current, invocation.selectionItemId);
        }
        if (invocation.stale) staleAction = true;
        return invocation;
      };
      const event = await showTuiScreen(
        ctx,
        screen,
        navigator.selectionFor(screenId, selectableItemIds(screen)),
        searchQueries.get(screenId),
        menuSignal,
        {
          onSelectionChange: (itemId) => navigator.rememberSelection(screenId, itemId),
          onSearchQueryChange: (query) => searchQueries.set(screenId, query),
        },
      );
      if (staleAction || !isMenuCurrent(options) || menuSignal.aborted) {
        return { kind: "stale" };
      }
      if (!event) {
        navigator.apply({ kind: "close" });
        continue;
      }
      if (event.kind === "back" || event.kind === "close") {
        searchQueries.delete(screenId);
        navigator.apply({ kind: event.kind });
        continue;
      }
      if (event.kind === "transition") {
        if (event.transition.kind !== "stay") searchQueries.delete(screenId);
        navigator.apply(event.transition);
        continue;
      }
      const outcome = await interact({ kind: "activate", itemId: event.itemId });
      if (outcome.stale) return { kind: "stale" };
      if (outcome.transition.kind !== "stay") searchQueries.delete(screenId);
      navigator.apply(outcome.transition);
    }
    return closedMenuResult(navigator.closeReason);
  } catch (error) {
    if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
    await reportMenuError(ctx, options, error);
    if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
    return { kind: "error", error };
  } finally {
    menuController.abort(new DOMException("Menu closed", "AbortError"));
  }
}

function selectableItemIds<ScreenId extends string, ActionId extends string>(screen: MenuScreen<ScreenId, ActionId>) {
  const itemIds = screen.items.map((item) => item.id);
  if (screen.kind !== "choice") return itemIds;
  const preferred = [screen.initialItemId, screen.currentItemId].find(
    (itemId): itemId is string => itemId !== undefined && itemIds.includes(itemId),
  );
  return preferred ? [preferred, ...itemIds.filter((itemId) => itemId !== preferred)] : itemIds;
}

async function showTuiScreen<ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  ctx: Context,
  screen: MenuScreen<ScreenId, ActionId>,
  selectedItemId: string | undefined,
  searchQuery: string | undefined,
  menuSignal: AbortSignal,
  callbacks: {
    onSelectionChange(itemId: string): void;
    onSearchQueryChange(query: string): void;
  },
): Promise<InternalScreenEvent<ScreenId> | undefined> {
  let component: MenuScreenComponent | undefined;
  let removeAbortListener = () => {};
  try {
    return await uiFor(ctx).custom<InternalScreenEvent<ScreenId> | undefined>((tui, theme, keybindings, done) => {
      const screenController = new AbortController();
      let finished = false;
      const finish = (event: InternalScreenEvent<ScreenId>) => {
        if (finished) return;
        finished = true;
        done(event);
      };
      const abortScreen = () => {
        screenController.abort(new DOMException("Menu owner disposed", "AbortError"));
        finish({ kind: "close" });
      };
      menuSignal.addEventListener("abort", abortScreen, { once: true });
      removeAbortListener = () => menuSignal.removeEventListener("abort", abortScreen);
      if (menuSignal.aborted) abortScreen();
      component = createMenuScreenComponent({
        screen,
        selectedItemId,
        searchQuery,
        tui,
        theme,
        keybindings,
        onEvent: finish,
        onSelectionChange: callbacks.onSelectionChange,
        onSearchQueryChange: callbacks.onSearchQueryChange,
        onTransition: (transition) => finish({ kind: "transition", transition }),
        onDispose: () => {
          removeAbortListener();
          screenController.abort(new DOMException("Menu screen disposed", "AbortError"));
        },
      });
      return component;
    });
  } finally {
    removeAbortListener();
    await component?.waitForPending();
  }
}

async function runDialogMenu<State, ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  ctx: Context,
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
  options: RunMenuOptions<State, Context>,
): Promise<RunMenuResult> {
  const controller = new AbortController();
  const menuSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const navigator = createMenuNavigator(definition.start);
  try {
    while (!navigator.closed) {
      const loaded = await loadState(ctx, options, menuSignal);
      if (loaded.kind !== "loaded") return loaded.result;
      const state = loaded.state;
      const screen = resolveMenuScreen(definition, navigator.current, state);
      const interact = (interaction: MenuInteraction) =>
        invokeMenuInteraction({
          ctx,
          definition,
          screen,
          state,
          menuSignal,
          runtime: options,
          interaction,
        });
      const rows = dialogRows(screen);
      const choice = await uiFor(ctx).select(
        dialogTitle(screen),
        rows.map((row) => row.label),
        { signal: menuSignal },
      );
      if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
      if (!choice) {
        navigator.apply({ kind: "back" });
        continue;
      }
      const selectedRow = rows.find((row) => row.label === choice);
      if (!selectedRow) continue;
      if (selectedRow.kind === "exit") {
        const destination = "hint" in screen ? (screen.hint ?? "back") : "back";
        navigator.apply({ kind: destination });
        continue;
      }
      const outcome = await interact(selectedRow.interaction);
      if (outcome.stale) return { kind: "stale" };
      navigator.apply(outcome.transition);
    }
    return closedMenuResult(navigator.closeReason);
  } catch (error) {
    if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
    await reportMenuError(ctx, options, error);
    if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
    return { kind: "error", error };
  } finally {
    controller.abort(new DOMException("Menu closed", "AbortError"));
  }
}

function dialogTitle<ScreenId extends string, ActionId extends string>(screen: MenuScreen<ScreenId, ActionId>) {
  return [safeMenuText(screen.title), ...(("lines" in screen && screen.lines) || []).map(safeMenuText)]
    .filter(Boolean)
    .join("\n");
}

type DialogRow = { kind: "interaction"; interaction: MenuInteraction; label: string } | { kind: "exit"; label: string };

function dialogRows<ScreenId extends string, ActionId extends string>(
  screen: MenuScreen<ScreenId, ActionId>,
): DialogRow[] {
  if (screen.kind === "actions") {
    return uniqueDialogRows(
      screen.items.map((item) => ({
        kind: "interaction",
        interaction: { kind: "activate", itemId: item.id },
        label: actionMenuDialogLabel(item),
      })),
    );
  }
  const rows: DialogRow[] = screen.items.map((item) => ({
    kind: "interaction" as const,
    interaction: { kind: "activate" as const, itemId: item.id },
    label: choiceDialogLabel(item, screen),
  }));
  rows.push({ kind: "exit", label: dialogExitChoice(screen) });
  return uniqueDialogRows(rows);
}

function choiceDialogLabel<ActionId extends string>(
  item: MenuChoiceItem,
  screen: ChoiceScreen<ActionId>,
): string {
  const label = safeMenuText(item.label);
  const current = item.id === screen.currentItemId ? " (current)" : "";
  return item.disabled
    ? `[-] ${label} (unavailable${item.disabledReason ? `: ${safeMenuText(item.disabledReason)}` : ""})`
    : `${label}${current}`;
}

function uniqueDialogRows(rows: readonly DialogRow[]): DialogRow[] {
  const used = new Set<string>();
  return rows.map((row) => ({ ...row, label: uniqueDialogLabel(row.label, used) }));
}

function uniqueDialogLabel(base: string, used: Set<string>) {
  let label = base;
  let suffix = 2;
  while (used.has(label)) {
    label = `${base} [${suffix}]`;
    suffix += 1;
  }
  used.add(label);
  return label;
}

function dialogExitChoice<ScreenId extends string, ActionId extends string>(screen: MenuScreen<ScreenId, ActionId>) {
  return screen.hint === "close" ? "Done" : "Back";
}

async function loadState<State, Context extends MenuContext>(
  ctx: Context,
  options: RunMenuOptions<State, Context>,
  signal: AbortSignal,
): Promise<{ kind: "loaded"; state: State } | { kind: "result"; result: RunMenuResult }> {
  if (signal.aborted || !isMenuCurrent(options)) {
    return { kind: "result", result: { kind: "stale" } };
  }
  try {
    const state = await options.getState({ ctx, signal });
    if (signal.aborted || !isMenuCurrent(options)) {
      return { kind: "result", result: { kind: "stale" } };
    }
    return { kind: "loaded", state };
  } catch (error) {
    if (signal.aborted || !isMenuCurrent(options)) {
      return { kind: "result", result: { kind: "stale" } };
    }
    await reportMenuError(ctx, options, error);
    if (signal.aborted || !isMenuCurrent(options)) {
      return { kind: "result", result: { kind: "stale" } };
    }
    return { kind: "result", result: { kind: "error", error } };
  }
}

function closedMenuResult(reason: MenuCloseReason | undefined): RunMenuResult {
  if (reason === undefined) throw new Error("Menu navigator closed without a termination reason");
  return { kind: "closed", reason };
}

function uiFor(ctx: MenuContext): ExtensionCommandContext["ui"] {
  // Pi core packages are peers and can be typechecked at multiple compatible versions in one tree.
  // The runtime uses only this stable UI surface and never adds command-only context capabilities.
  return ctx.ui as ExtensionCommandContext["ui"];
}
