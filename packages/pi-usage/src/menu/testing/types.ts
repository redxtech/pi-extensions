import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";

export type TuiHarnessKey =
  | "app.models.save"
  | "app.thinking.save"
  | "app.thinking.cycle"
  | "tui.input.tab"
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "tui.select.confirm"
  | "tui.select.cancel"
  | "tui.input.submit"
  | "ctrl+c"
  | "home"
  | "end";

export interface TuiHarnessOptions {
  width?: number;
  rows?: number;
  theme?: Pick<Theme, "fg" | "bold">;
  keybindings?: Pick<KeybindingsManager, "matches" | "getKeys"> & {
    getDefinition?(binding: string): unknown;
  };
}

export interface TuiHarnessResize {
  width?: number;
  rows?: number;
}

export interface TuiHarnessMouseEvent {
  type: TuiMouseEvent["type"];
  x: number;
  y: number;
  button?: TuiMouseEvent["button"];
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  wheelDelta?: number;
  clickCount?: number;
}

export interface TuiHarness {
  readonly custom: ExtensionContext["ui"]["custom"];
  readonly openCount: number;
  readonly requestRenderCount: number;
  readonly isOpen: boolean;
  readonly isFocusable: boolean;
  readonly focused: boolean;
  readonly result: unknown;
  readonly resultPromise: Promise<unknown>;
  waitForOpen(): Promise<number>;
  render(width?: number): readonly string[];
  press(key: TuiHarnessKey): readonly string[];
  mouse(event: TuiHarnessMouseEvent): readonly string[];
  send(data: string): readonly string[];
  type(text: string): readonly string[];
  resize(size: TuiHarnessResize): readonly string[];
  invalidate(): void;
  setFocused(focused: boolean): void;
  waitForPending(): Promise<void>;
  dispose(): void;
}
