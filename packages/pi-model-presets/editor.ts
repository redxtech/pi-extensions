import type { CycleDirection } from "./state.ts"

export interface ComposableEditor {
  handleInput(data: string): void
  getText(): string
  isShowingAutocomplete?(): boolean
}

interface PresetCyclingOptions {
  getDirection(data: string): CycleDirection | undefined
  isIdle(): boolean
  cycle(direction: CycleDirection): void
}

export function decoratePresetCycling(
  editor: ComposableEditor,
  options: PresetCyclingOptions,
): () => void {
  const originalHandleInput = editor.handleInput
  const forwardInput = (data: string) => originalHandleInput.call(editor, data)

  function handleInput(data: string): void {
    const direction = options.getDirection(data)
    if (
      direction === undefined
      || editor.getText().length > 0
      || (editor.isShowingAutocomplete?.() ?? false)
      || !options.isIdle()
    ) {
      forwardInput(data)
      return
    }

    options.cycle(direction)
  }

  editor.handleInput = handleInput

  return () => {
    if (editor.handleInput === handleInput) {
      editor.handleInput = originalHandleInput
    }
  }
}
