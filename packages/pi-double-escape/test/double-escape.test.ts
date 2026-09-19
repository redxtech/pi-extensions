import assert from "node:assert/strict"
import test from "node:test"
import { getDebounceMs } from "../src/config.ts"
import { decorateEditor } from "../src/decorate-editor.ts"

class FakeScheduler {
  private nextId = 1
  private callbacks = new Map<number, () => void>()

  setTimeout(callback: () => void): number {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    return id
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number)
  }

  runAll(): void {
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of callbacks) callback()
  }
}

function createHarness(options: {
  idle?: boolean
  autocomplete?: boolean
} = {}) {
  const inputs: string[] = []
  const hints: boolean[] = []
  let renders = 0
  let idle = options.idle ?? false
  let autocomplete = options.autocomplete ?? false
  const scheduler = new FakeScheduler()

  const originalHandleInput = function (data: string): void {
    inputs.push(data)
  }

  const editor = {
    handleInput: originalHandleInput,
    isShowingAutocomplete: () => autocomplete,
  }

  const cleanup = decorateEditor(editor, {
    debounceMs: 1500,
    isEscape: (data) => data === "escape",
    isIdle: () => idle,
    requestRender: () => {
      renders += 1
    },
    setHintVisible: (visible) => hints.push(visible),
    scheduler,
  })

  return {
    editor,
    originalHandleInput,
    inputs,
    hints,
    scheduler,
    cleanup,
    renders: () => renders,
    setIdle: (value: boolean) => {
      idle = value
    },
    setAutocomplete: (value: boolean) => {
      autocomplete = value
    },
  }
}

test("requires two Escape presses while Pi is active", () => {
  const harness = createHarness()

  harness.editor.handleInput("escape")
  assert.deepEqual(harness.inputs, [])
  assert.deepEqual(harness.hints, [true])

  harness.editor.handleInput("escape")
  assert.deepEqual(harness.inputs, ["escape"])
  assert.deepEqual(harness.hints, [true, false])
  assert.equal(harness.renders(), 2)
})

test("forwards Escape immediately while Pi is idle", () => {
  const harness = createHarness({ idle: true })

  harness.editor.handleInput("escape")

  assert.deepEqual(harness.inputs, ["escape"])
  assert.deepEqual(harness.hints, [])
})

test("forwards Escape immediately when autocomplete is visible", () => {
  const harness = createHarness({ autocomplete: true })

  harness.editor.handleInput("escape")

  assert.deepEqual(harness.inputs, ["escape"])
  assert.deepEqual(harness.hints, [])
})

test("a non-Escape key clears the armed state and is forwarded", () => {
  const harness = createHarness()

  harness.editor.handleInput("escape")
  harness.editor.handleInput("x")
  harness.editor.handleInput("escape")

  assert.deepEqual(harness.inputs, ["x"])
  assert.deepEqual(harness.hints, [true, false, true])
})

test("the timeout clears the armed state", () => {
  const harness = createHarness()

  harness.editor.handleInput("escape")
  harness.scheduler.runAll()
  harness.editor.handleInput("escape")

  assert.deepEqual(harness.inputs, [])
  assert.deepEqual(harness.hints, [true, false, true])
})

test("forwards input with the original editor as this", () => {
  const editor = {
    calls: 0,
    handleInput(this: { calls: number }): void {
      this.calls += 1
    },
  }

  decorateEditor(editor, {
    debounceMs: 1500,
    isEscape: () => false,
    isIdle: () => true,
    requestRender: () => {},
    setHintVisible: () => {},
  })

  editor.handleInput("x")
  assert.equal(editor.calls, 1)
})

test("cleanup clears state and restores the original handler", () => {
  const harness = createHarness()

  harness.editor.handleInput("escape")
  harness.cleanup()

  assert.equal(harness.editor.handleInput, harness.originalHandleInput)
  assert.deepEqual(harness.hints, [true, false])

  harness.editor.handleInput("escape")
  assert.deepEqual(harness.inputs, ["escape"])
})

test("reads and bounds the configured debounce interval", () => {
  assert.equal(getDebounceMs({}), 1500)
  assert.equal(getDebounceMs({ PI_DOUBLE_ESCAPE_MS: "750" }), 750)
  assert.equal(getDebounceMs({ PI_DOUBLE_ESC_MS: "900" }), 900)
  assert.equal(getDebounceMs({ PI_DOUBLE_ESCAPE_MS: "invalid" }), 1500)
  assert.equal(getDebounceMs({ PI_DOUBLE_ESCAPE_MS: "1" }), 100)
  assert.equal(getDebounceMs({ PI_DOUBLE_ESCAPE_MS: "50000" }), 10_000)
})
