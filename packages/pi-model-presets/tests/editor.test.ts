import assert from "node:assert/strict"
import test from "node:test"
import { decoratePresetCycling, type ComposableEditor } from "../editor.ts"
import type { CycleDirection } from "../state.ts"

interface TestEditor extends ComposableEditor {
  forwarded: string[]
  text: string
  autocomplete: boolean
}

function createEditor(): TestEditor {
  return {
    forwarded: [],
    text: "",
    autocomplete: false,
    handleInput(data) {
      this.forwarded.push(data)
    },
    getText() {
      return this.text
    },
    isShowingAutocomplete() {
      return this.autocomplete
    },
  }
}

function decorate(
  editor: TestEditor,
  cycles: CycleDirection[],
  idle = true,
): () => void {
  return decoratePresetCycling(editor, {
    getDirection(data) {
      if (data === "next") return "forward"
      if (data === "previous") return "backward"
      return undefined
    },
    isIdle: () => idle,
    cycle: (direction) => cycles.push(direction),
  })
}

test("cycles in both directions when the editor is empty", () => {
  const editor = createEditor()
  const cycles: CycleDirection[] = []
  decorate(editor, cycles)

  editor.handleInput("next")
  editor.handleInput("previous")

  assert.deepEqual(cycles, ["forward", "backward"])
  assert.deepEqual(editor.forwarded, [])
})

test("forwards configured keys when the editor has content", () => {
  const editor = createEditor()
  const cycles: CycleDirection[] = []
  editor.text = " "
  decorate(editor, cycles)

  editor.handleInput("next")

  assert.deepEqual(cycles, [])
  assert.deepEqual(editor.forwarded, ["next"])
})

test("forwards input while autocomplete is visible or the session is busy", () => {
  const autocompleteEditor = createEditor()
  const busyEditor = createEditor()
  const cycles: CycleDirection[] = []
  autocompleteEditor.autocomplete = true
  decorate(autocompleteEditor, cycles)
  decorate(busyEditor, cycles, false)

  autocompleteEditor.handleInput("next")
  busyEditor.handleInput("previous")

  assert.deepEqual(cycles, [])
  assert.deepEqual(autocompleteEditor.forwarded, ["next"])
  assert.deepEqual(busyEditor.forwarded, ["previous"])
})

test("cleanup restores the previous editor handler", () => {
  const editor = createEditor()
  const cycles: CycleDirection[] = []
  const cleanup = decorate(editor, cycles)

  cleanup()
  editor.handleInput("next")

  assert.deepEqual(cycles, [])
  assert.deepEqual(editor.forwarded, ["next"])
})
