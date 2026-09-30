import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui"
import {
  DEFAULT_RENAME_MODEL,
  formatRenameModelKey,
  type RenameModelPreference,
} from "./models.ts"

const USE_DEFAULT_VALUE = "__auto-rename-default__"
const SAVE_VALUE = "__auto-rename-save__"
const MAX_VISIBLE_ITEMS = 10

export type ModelPickerResult =
  | { action: "default" }
  | { action: "models"; models: RenameModelPreference[] }
  | { action: "cancel" }

interface ModelPickerItem {
  readonly value: string
  readonly label: string
  readonly description?: string
  readonly model?: RenameModelPreference
}

function toggleModel(
  models: RenameModelPreference[],
  model: RenameModelPreference,
): void {
  const key = formatRenameModelKey(model)
  const index = models.findIndex((item) => formatRenameModelKey(item) === key)
  if (index < 0) models.push(model)
  else models.splice(index, 1)
}

function modelLabel(
  model: RenameModelPreference,
  selected: readonly RenameModelPreference[],
): string {
  const key = formatRenameModelKey(model)
  const index = selected.findIndex((item) => formatRenameModelKey(item) === key)
  return `${index < 0 ? "[ ]" : `[${index + 1}]`} ${key}`
}

class RenameModelPicker implements Component, Focusable {
  private readonly theme: Theme
  private readonly items: ModelPickerItem[]
  private readonly onDone: (result: ModelPickerResult) => void
  private readonly searchInput = new Input()
  private selectedIndex = 0
  private readonly selected: RenameModelPreference[]

  constructor(
    theme: Theme,
    models: readonly RenameModelPreference[],
    selected: readonly RenameModelPreference[],
    onDone: (result: ModelPickerResult) => void,
  ) {
    this.theme = theme
    this.selected = [...selected]
    this.items = [
      { value: SAVE_VALUE, label: "Save model order" },
      {
        value: USE_DEFAULT_VALUE,
        label: "Use default",
        description: formatRenameModelKey(DEFAULT_RENAME_MODEL),
      },
      ...models.map((model) => ({
        value: formatRenameModelKey(model),
        label: formatRenameModelKey(model),
        model,
      })),
    ]
    this.onDone = onDone
  }

  get focused(): boolean {
    return this.searchInput.focused
  }

  set focused(value: boolean) {
    this.searchInput.focused = value
  }

  invalidate(): void {
    this.searchInput.invalidate()
  }

  render(width: number): string[] {
    const filteredItems = this.getFilteredItems()
    const startIndex = getVisibleStartIndex(
      this.selectedIndex,
      filteredItems.length,
    )
    const visibleItems = filteredItems.slice(
      startIndex,
      startIndex + MAX_VISIBLE_ITEMS,
    )
    const lines = [
      this.theme.fg("accent", this.theme.bold("Rename models")),
      this.theme.fg("dim", "Search"),
      ...this.searchInput.render(width),
      "",
    ]

    if (visibleItems.length === 0) {
      lines.push(this.theme.fg("warning", "No matching models"))
    } else {
      for (const [index, item] of visibleItems.entries()) {
        lines.push(
          this.renderItem(
            item,
            startIndex + index === this.selectedIndex,
            width,
          ),
        )
      }
    }

    if (filteredItems.length > MAX_VISIBLE_ITEMS) {
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth(
            `${this.selectedIndex + 1}/${filteredItems.length}`,
            width,
          ),
        ),
      )
    }

    lines.push(
      "",
      this.theme.fg("dim", "↑↓ navigate • enter toggle/save • esc cancel"),
      this.theme.fg("dim", "Models run in selection order. Remove and select again to move a model last."),
    )
    return lines.map((line) => truncateToWidth(line, width))
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onDone({ action: "cancel" })
      return
    }

    if (matchesKey(data, Key.enter)) {
      this.selectCurrent()
      return
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1)
      return
    }

    if (matchesKey(data, Key.down)) {
      this.moveSelection(1)
      return
    }

    const previousFilter = this.getFilter()
    this.searchInput.handleInput(data)
    if (this.getFilter() !== previousFilter) this.selectedIndex = 0
  }

  private renderItem(
    item: ModelPickerItem,
    isSelected: boolean,
    width: number,
  ): string {
    const prefix = isSelected ? "→ " : "  "
    const text = item.model ? modelLabel(item.model, this.selected) : item.label
    const label = isSelected
      ? this.theme.fg("accent", text)
      : this.theme.fg("text", text)
    const description = item.description
      ? this.theme.fg("dim", ` ${item.description}`)
      : ""
    return truncateToWidth(`${prefix}${label}${description}`, width)
  }

  private moveSelection(delta: number): void {
    const count = this.getFilteredItems().length
    if (count === 0) return
    this.selectedIndex = (this.selectedIndex + delta + count) % count
  }

  private selectCurrent(): void {
    const item = this.getFilteredItems()[this.selectedIndex]
    if (!item) return

    if (item.value === SAVE_VALUE) {
      if (this.selected.length > 0) {
        this.onDone({ action: "models", models: [...this.selected] })
      }
      return
    }

    if (item.value === USE_DEFAULT_VALUE) {
      this.onDone({ action: "default" })
      return
    }

    if (item.model) toggleModel(this.selected, item.model)
  }

  private getFilter(): string {
    return this.searchInput.getValue().trim().toLowerCase()
  }

  private getFilteredItems(): ModelPickerItem[] {
    const filter = this.getFilter()
    if (!filter) return this.items
    return this.items.filter(
      (item) =>
        item.label.toLowerCase().includes(filter) ||
        item.description?.toLowerCase().includes(filter),
    )
  }
}

function getVisibleStartIndex(
  selectedIndex: number,
  itemCount: number,
): number {
  return Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE_ITEMS / 2),
      itemCount - MAX_VISIBLE_ITEMS,
    ),
  )
}

class HiddenFooter implements Component {
  invalidate(): void {}

  render(): string[] {
    return []
  }
}

export async function pickRenameModels(
  ctx: ExtensionContext,
  models: readonly RenameModelPreference[],
  selected: readonly RenameModelPreference[] = [],
): Promise<ModelPickerResult> {
  if (!ctx.hasUI) return { action: "cancel" }

  const choices = [...new Map(
    [...models, ...selected].map((model) => [formatRenameModelKey(model), model]),
  ).values()]

  if (ctx.mode !== "tui") {
    const defaultLabel = `Use default (${formatRenameModelKey(DEFAULT_RENAME_MODEL)})`
    const saveLabel = "Save model order"
    const order = [...selected]
    while (true) {
      const labels = choices.map((model) => modelLabel(model, order))
      const selection = await ctx.ui.select("Rename models (selection order)", [
        ...(order.length > 0 ? [saveLabel] : []),
        defaultLabel,
        ...labels,
      ])
      if (!selection) return { action: "cancel" }
      if (selection === defaultLabel) return { action: "default" }
      if (selection === saveLabel && order.length > 0) {
        return { action: "models", models: order }
      }

      const model = choices[labels.indexOf(selection)]
      if (!model) return { action: "cancel" }
      toggleModel(order, model)
    }
  }

  ctx.ui.setFooter(() => new HiddenFooter())
  return ctx.ui
    .custom<ModelPickerResult>((tui, theme, _keybindings, done) => {
      const picker = new RenameModelPicker(theme, choices, selected, done)
      return {
        get focused() {
          return picker.focused
        },
        set focused(value: boolean) {
          picker.focused = value
        },
        render: (width) => picker.render(width),
        invalidate: () => picker.invalidate(),
        handleInput: (data) => {
          picker.handleInput(data)
          tui.requestRender()
        },
      }
    })
    .finally(() => ctx.ui.setFooter(undefined))
}
