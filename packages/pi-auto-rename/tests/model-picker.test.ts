import assert from "node:assert/strict"
import test from "node:test"
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui"
import { visibleWidth } from "@earendil-works/pi-tui"
import { pickRenameModels, type ModelPickerResult } from "../model-picker.ts"
import { DEFAULT_RENAME_MODEL, formatRenameModelKey, type RenameModelPreference } from "../models.ts"

const first = { provider: "provider-a", id: "first" }
const second = { provider: "provider-b", id: "second" }
const third = { provider: "provider-c", id: "third" }
const models = [first, second, third]

function rpcContext(steps: readonly (string | undefined)[]) {
  let index = 0
  const menus: string[][] = []
  const ctx = {
    hasUI: true, mode: "rpc",
    ui: {
      async select(_title: string, options: string[]) {
        menus.push(options)
        assert.ok(index < steps.length, "unexpected additional picker dialog")
        return steps[index++]
      },
    },
  } as unknown as ExtensionContext
  return { ctx, menus }
}

interface PickerComponent extends Component, Focusable {
  handleInput(data: string): void
}

function tuiContext(drive: (picker: PickerComponent) => void) {
  const footers: unknown[] = []
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme
  const ctx = {
    hasUI: true, mode: "tui",
    ui: {
      setFooter(footer: unknown) { footers.push(footer) },
      custom(factory: (tui: TUI, theme: Theme, keys: unknown, done: (result: ModelPickerResult) => void) => PickerComponent) {
        return new Promise<ModelPickerResult>((resolve) => {
          const picker = factory({ requestRender() {} } as TUI, theme, undefined, resolve)
          drive(picker)
        })
      },
    },
  } as unknown as ExtensionContext
  return { ctx, footers }
}

const down = "\x1b[B"
const up = "\x1b[A"
const enter = "\r"

test("RPC picker saves models in selection order rather than catalog order", async () => {
  const f = rpcContext(["[ ] provider-b/second", "[ ] provider-a/first", "Save model order"])
  assert.deepEqual(await pickRenameModels(f.ctx, models), { action: "models", models: [second, first] })
  assert.equal(f.menus[0]?.includes("Save model order"), false)
  assert.ok(f.menus[2]?.includes("[1] provider-b/second"))
  assert.ok(f.menus[2]?.includes("[2] provider-a/first"))
})

test("RPC picker removes and re-adds models to change priority", async () => {
  const initial = [first, second]
  const f = rpcContext(["[1] provider-a/first", "[ ] provider-a/first", "Save model order"])
  assert.deepEqual(await pickRenameModels(f.ctx, models, initial), { action: "models", models: [second, first] })
  assert.deepEqual(initial, [first, second])
})

test("RPC cancellation discards pending changes", async () => {
  const initial = [first]
  const f = rpcContext(["[ ] provider-b/second", undefined])
  assert.deepEqual(await pickRenameModels(f.ctx, models, initial), { action: "cancel" })
  assert.deepEqual(initial, [first])
})

test("RPC picker can reset to the default with no authenticated models", async () => {
  const f = rpcContext([`Use default (${formatRenameModelKey(DEFAULT_RENAME_MODEL)})`])
  assert.deepEqual(await pickRenameModels(f.ctx, []), { action: "default" })
})

test("RPC picker retains configured models missing from the authenticated catalog", async () => {
  const f = rpcContext(["Save model order"])
  assert.deepEqual(await pickRenameModels(f.ctx, [second], [first]), { action: "models", models: [first] })
  assert.ok(f.menus[0]?.includes("[1] provider-a/first"))
})

test("RPC picker cannot save after removing the last model", async () => {
  const f = rpcContext(["[1] provider-a/first", undefined])
  assert.deepEqual(await pickRenameModels(f.ctx, models, [first]), { action: "cancel" })
  assert.equal(f.menus[1]?.includes("Save model order"), false)
})

test("without UI the picker cancels", async () => {
  assert.deepEqual(await pickRenameModels({ hasUI: false } as ExtensionContext, models), { action: "cancel" })
})

test("TUI toggles several models and saves attempt numbers in selection order", async () => {
  const f = tuiContext((picker) => {
    picker.focused = true
    assert.equal(picker.focused, true)
    for (const key of [down, down, down, enter, up, enter]) picker.handleInput(key)
    const rendered = picker.render(100).join("\n")
    assert.match(rendered, /\[1\] provider-b\/second/)
    assert.match(rendered, /\[2\] provider-a\/first/)
    for (const line of picker.render(20)) assert.ok(visibleWidth(line) <= 20)
    picker.invalidate()
    picker.handleInput(up)
    picker.handleInput(up)
    picker.handleInput(enter)
  })
  assert.deepEqual(await pickRenameModels(f.ctx, models), { action: "models", models: [second, first] })
  assert.equal(f.footers.length, 2)
  assert.equal(f.footers[1], undefined)
})

test("TUI search preserves pending order and Escape cancels changes", async () => {
  const selected: RenameModelPreference[] = [first]
  const f = tuiContext((picker) => {
    picker.handleInput("second")
    picker.handleInput(enter)
    assert.match(picker.render(80).join("\n"), /\[2\] provider-b\/second/)
    picker.handleInput("\x1b")
  })
  assert.deepEqual(await pickRenameModels(f.ctx, models, selected), { action: "cancel" })
  assert.deepEqual(selected, [first])
  assert.equal(f.footers[1], undefined)
})

test("TUI reset works with no authenticated models", async () => {
  const f = tuiContext((picker) => {
    picker.handleInput(down)
    picker.handleInput(enter)
  })
  assert.deepEqual(await pickRenameModels(f.ctx, []), { action: "default" })
})

test("TUI restores the footer when its custom UI rejects", async () => {
  const f = tuiContext(() => { throw new Error("UI failure") })
  await assert.rejects(pickRenameModels(f.ctx, models), /UI failure/)
  assert.equal(f.footers[1], undefined)
})
