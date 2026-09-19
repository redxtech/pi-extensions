import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Common, version-neutral Pi context capabilities used by the menu runtime. */
export interface MenuContext {
  mode: ExtensionContext["mode"];
  hasUI: boolean;
  ui: object;
}

export type MenuCloseReason = "back" | "close";

export type MenuTransition<ScreenId extends string> =
  | { kind: "stay" }
  | { kind: "back" }
  | { kind: "close" }
  | { kind: "to"; screen: ScreenId };

export type MenuActionResult<ScreenId extends string> =
  | MenuTransition<ScreenId>
  | { kind: "rejected"; error?: unknown }
  | undefined;

export interface MenuActionContext<State, Context extends MenuContext = ExtensionCommandContext> {
  ctx: Context;
  state: State;
  signal: AbortSignal;
  itemId: string;
}

export type MenuActionHandler<State, ScreenId extends string, Context extends MenuContext = ExtensionCommandContext> = (
  context: MenuActionContext<State, Context>,
) => MenuActionResult<ScreenId> | Promise<MenuActionResult<ScreenId>>;

interface MenuItemBase {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

type ActionMenuItemBase = MenuItemBase & {
  disabledReason?: string;
};

export type ActionMenuItem<ScreenId extends string, ActionId extends string> =
  | (ActionMenuItemBase & { to: ScreenId; action?: never; close?: never })
  | (ActionMenuItemBase & {
      action: ActionId;
      to?: never;
      close?: never;
      busyLabel?: string;
    })
  | (ActionMenuItemBase & { close: true; to?: never; action?: never });

export interface ActionsScreen<ScreenId extends string, ActionId extends string> {
  kind: "actions";
  title: string;
  lines?: readonly string[];
  items: readonly ActionMenuItem<ScreenId, ActionId>[];
  hint?: "back" | "close";
}

export interface MenuChoiceItem extends MenuItemBase {
  details?: readonly string[];
  disabledReason?: string;
  /** Additional non-rendered text used by optional TUI fuzzy search. */
  searchText?: string;
}

export interface ChoiceScreen<ActionId extends string> {
  kind: "choice";
  title: string;
  lines?: readonly string[];
  items: readonly MenuChoiceItem[];
  action: ActionId;
  currentItemId?: string;
  initialItemId?: string;
  /** Enables TUI-only fuzzy filtering while RPC keeps one deterministic unfiltered list. */
  enableSearch?: boolean;
  viewportSize?: number;
  hint?: "back" | "close";
}

export type MenuScreen<ScreenId extends string, ActionId extends string> =
  | ActionsScreen<ScreenId, ActionId>
  | ChoiceScreen<ActionId>;

export interface MenuScreenContext<State> {
  state: State;
}

export type MenuScreenFactory<State, ScreenId extends string, ActionId extends string> = (
  context: MenuScreenContext<State>,
) => MenuScreen<ScreenId, ActionId>;

export interface MenuDefinition<
  State,
  ScreenId extends string,
  ActionId extends string,
  Context extends MenuContext = ExtensionCommandContext,
> {
  start: ScreenId;
  screens: Record<ScreenId, MenuScreenFactory<State, ScreenId, ActionId>>;
  actions: Record<ActionId, MenuActionHandler<State, ScreenId, Context>>;
}