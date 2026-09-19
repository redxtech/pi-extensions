import {
  CustomEditor,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent"
import { Key, matchesKey } from "@earendil-works/pi-tui"
import { getDebounceMs } from "./src/config.ts"
import { decorateEditor } from "./src/decorate-editor.ts"

const STATUS_KEY = "double-escape"

export default function doubleEscape(pi: ExtensionAPI): void {
  let cleanupEditor: (() => void) | undefined

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return

    // preserve the existing custom editor and decorate the instance it creates.
    const previousFactory = ctx.ui.getEditorComponent()
    const debounceMs = getDebounceMs(process.env)

    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      cleanupEditor?.()

      const editor = previousFactory?.(tui, editorTheme, keybindings)
        ?? new CustomEditor(tui, editorTheme, keybindings)

      cleanupEditor = decorateEditor(editor, {
        debounceMs,
        isEscape: (data) =>
          matchesKey(data, Key.escape)
          && keybindings.matches(data, "app.interrupt"),
        isIdle: () => ctx.isIdle(),
        requestRender: () => tui.requestRender(),
        setHintVisible: (visible) => {
          ctx.ui.setStatus(
            STATUS_KEY,
            visible ? "esc again to abort" : undefined,
          )
        },
      })

      return editor
    })
  })

  pi.on("session_shutdown", (_event, ctx) => {
    cleanupEditor?.()
    cleanupEditor = undefined
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
