interface ComposableEditor {
  handleInput(data: string): void
  isShowingAutocomplete?(): boolean
}

interface Scheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

interface DoubleEscapeOptions {
  debounceMs: number
  isEscape(data: string): boolean
  isIdle(): boolean
  requestRender(): void
  setHintVisible(visible: boolean): void
  scheduler?: Scheduler
}

const defaultScheduler: Scheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

/** decorate an editor instance and return a cleanup function. */
export function decorateEditor(
  editor: ComposableEditor,
  options: DoubleEscapeOptions,
): () => void {
  const scheduler = options.scheduler ?? defaultScheduler
  const originalHandleInput = editor.handleInput
  const forwardInput = (data: string) => originalHandleInput.call(editor, data)
  let state: { kind: "idle" } | { kind: "armed"; timer: unknown } = {
    kind: "idle",
  }

  function disarm(): void {
    if (state.kind === "idle") return
    scheduler.clearTimeout(state.timer)
    state = { kind: "idle" }
    options.setHintVisible(false)
    options.requestRender()
  }

  function arm(): void {
    disarm()
    const timer = scheduler.setTimeout(() => {
      if (state.kind !== "armed" || state.timer !== timer) return
      state = { kind: "idle" }
      options.setHintVisible(false)
      options.requestRender()
    }, options.debounceMs)
    state = { kind: "armed", timer }
    options.setHintVisible(true)
    options.requestRender()
  }

  function handleInput(data: string): void {
    if (!options.isEscape(data)) {
      disarm()
      forwardInput(data)
      return
    }

    const autocompleteVisible = editor.isShowingAutocomplete?.() ?? false
    if (options.isIdle() || autocompleteVisible) {
      disarm()
      forwardInput(data)
      return
    }

    if (state.kind === "idle") {
      arm()
      return
    }

    disarm()
    forwardInput(data)
  }

  editor.handleInput = handleInput

  return () => {
    disarm()
    if (editor.handleInput === handleInput) {
      editor.handleInput = originalHandleInput
    }
  }
}
