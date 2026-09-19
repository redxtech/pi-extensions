import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { MenuScreen, MenuTransition } from "../types.ts";

const MENU_BINDINGS = [
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
  "tui.select.confirm",
  "tui.select.cancel",
  "tui.input.submit",
  "tui.altScreen.search",
  "tui.altScreen.searchNext",
  "tui.altScreen.searchPrevious",
  "tui.altScreen.searchClose",
] as const;
export type MenuBinding = (typeof MENU_BINDINGS)[number];

export interface RenderHost {
  readonly terminal: { readonly rows: number };
  requestRender(): void;
}

export interface MenuKeybindings {
  matches(data: string, binding: MenuBinding): boolean;
  getKeys(binding: MenuBinding): readonly string[];
}

export type MenuScreenEvent = { kind: "activate"; itemId: string } | { kind: "back" } | { kind: "close" };

export interface MenuScreenComponent extends Component {
  readonly __piTuiKitScreen?: true;
  handleInput(data: string): void;
  waitForPending(): Promise<void>;
  dispose?(): void;
}

export interface MenuScreenComponentOptions<ScreenId extends string, ActionId extends string> {
  screen: MenuScreen<ScreenId, ActionId>;
  selectedItemId?: string;
  tui: RenderHost;
  theme: Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "bg" | "inverse" | "italic" | "underline" | "strikethrough">>;
  keybindings: MenuKeybindings;
  onEvent(event: MenuScreenEvent): void;
  onSelectionChange?(itemId: string): void;
  onTransition?(transition: MenuTransition<ScreenId>): void;
  onError?(error: unknown): void;
  /** Internal standalone-interaction hint override. Declarative screens do not set this. */
  interactionHint?: string;
  /** Internal TUI-only query restoration for rejected searchable-choice actions. */
  searchQuery?: string;
  onSearchQueryChange?(query: string): void;
  onDispose?(): void;
}
