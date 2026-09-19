import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import {
  CancellableLoader,
  type AutocompleteItem,
} from "@earendil-works/pi-tui"
import {
  renameCurrentHerdrTarget,
  renameCurrentHerdrTargetIfDefault,
} from "./herdr.ts"
import {
  parseRenameLanguage,
  type RenameLanguage,
} from "./language.ts"
import { pickRenameModel } from "./model-picker.ts"
import {
  createRenameState,
  deleteModelPreference,
  formatAuthModelKey,
  formatModelPreference,
  formatRenameModelKey,
  getAuthenticatedTextModels,
  getRenameModelAuth,
  resolveInitialRenameConfig,
  saveModelPreference,
  saveRenameLanguage,
  type RenameState,
} from "./models.ts"
import {
  generateRename,
  getUserMessageContext,
} from "./naming.ts"

interface SessionContextReader {
  buildSessionContext(): { messages: AgentMessage[] }
}

const RENAME_SUBCOMMANDS: AutocompleteItem[] = [
  {
    value: "status",
    label: "status",
    description: "Show model and rename status",
  },
  {
    value: "config",
    label: "config",
    description: "Choose the rename model",
  },
  {
    value: "help",
    label: "help",
    description: "List rename commands",
  },
]

function hasSessionContextReader(value: unknown): value is SessionContextReader {
  return (
    typeof value === "object" &&
    value !== null &&
    "buildSessionContext" in value &&
    typeof value.buildSessionContext === "function"
  )
}

function getCurrentSessionMessages(ctx: ExtensionContext): AgentMessage[] {
  if (hasSessionContextReader(ctx.sessionManager)) {
    return ctx.sessionManager.buildSessionContext().messages
  }

  return buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  ).messages
}

function hasUserContext(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.buildContextEntries().some(
    (entry) => entry.type === "message" && entry.message.role === "user",
  )
}

async function applyRename(pi: ExtensionAPI, name: string): Promise<boolean> {
  pi.setSessionName(name)
  return renameCurrentHerdrTarget(name)
}

async function runRenameCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RenameState,
): Promise<void> {
  const context = getUserMessageContext(getCurrentSessionMessages(ctx))
  if (!context) {
    ctx.ui.notify("No conversation to rename yet.", "warning")
    return
  }

  if (ctx.mode === "tui") {
    ctx.ui.setWidget("pi-rename", (tui, theme) => {
      const color = (text: string) => theme.fg("dim", text)
      return new CancellableLoader(tui, color, color, "renaming session...")
    })
  }

  try {
    const result = await generateRename(
      ctx,
      state.modelConfig,
      context,
      state.language,
    )
    if (!result) {
      ctx.ui.notify("Could not generate a session name.", "error")
      return
    }

    let renamedHerdr = false
    let herdrError: string | undefined

    try {
      renamedHerdr = await applyRename(pi, result.name)
    } catch (error) {
      herdrError = error instanceof Error ? error.message : String(error)
    }

    if (result.source === "fallback") {
      ctx.ui.notify(
        [
          `Session renamed with fallback: ${result.name}`,
          `Could not use rename model: ${result.reason}`,
          ...(herdrError ? [`Herdr label rename failed: ${herdrError}`] : []),
        ].join("\n"),
        "warning",
      )
      return
    }

    if (herdrError) {
      ctx.ui.notify(
        `Session renamed, but Herdr label rename failed: ${herdrError}`,
        "warning",
      )
      return
    }

    ctx.ui.notify(
      renamedHerdr
        ? `Session and Herdr label renamed: ${result.name}`
        : `Session renamed: ${result.name}`,
      "info",
    )
  } finally {
    if (ctx.mode === "tui") ctx.ui.setWidget("pi-rename", undefined)
  }
}

function getRenameArgumentCompletions(
  prefix: string,
): AutocompleteItem[] | null {
  const query = prefix.trimStart().toLowerCase()
  const items = RENAME_SUBCOMMANDS.filter((item) =>
    item.value.startsWith(query),
  )
  return items.length > 0 ? items : null
}

async function configureRenameModel(
  ctx: ExtensionContext,
  state: RenameState,
): Promise<void> {
  const models = await getAuthenticatedTextModels(ctx)
  if (models.length === 0) {
    ctx.ui.notify(
      "No authenticated models available. Run /login or configure a model first.",
      "error",
    )
    return
  }

  const result = await pickRenameModel(ctx, models)
  if (result.action === "cancel") return

  try {
    if (result.action === "default") {
      deleteModelPreference()
      state.modelConfig = { kind: "missing" }
      ctx.ui.notify("Rename model reset to default.", "info")
      return
    }

    saveModelPreference(result.model)
    state.modelConfig = { kind: "configured", model: result.model }
    ctx.ui.notify(
      `Rename model set to ${formatRenameModelKey(result.model)}.`,
      "info",
    )
  } catch (error) {
    const reason = error instanceof SyntaxError ? "invalid JSON" : "write failed"
    ctx.ui.notify(`Could not update rename config: ${reason}.`, "error")
  }
}

function configureRenameLanguage(
  ctx: ExtensionContext,
  state: RenameState,
  value: string | undefined,
): void {
  const language = parseRenameLanguage(value)
  if (!language) {
    ctx.ui.notify("Use /rename config language <auto|BCP-47>", "error")
    return
  }

  try {
    saveRenameLanguage(language)
    state.language = language
    ctx.ui.notify(`Rename language set to ${language}.`, "info")
  } catch (error) {
    const reason = error instanceof SyntaxError ? "invalid JSON" : "write failed"
    ctx.ui.notify(`Could not update rename config: ${reason}.`, "error")
  }
}

async function notifyRenameStatus(
  ctx: ExtensionContext,
  state: RenameState,
): Promise<void> {
  let selectedModelLine = `selected model: ${formatModelPreference(state.modelConfig)}`
  let activeModelLine: string

  try {
    const modelAuth = await getRenameModelAuth(ctx, state.modelConfig)
    if (modelAuth.status === "ok") {
      const suffix = modelAuth.source === "default" ? " (default)" : ""
      selectedModelLine = `selected model: ${formatAuthModelKey(modelAuth.auth)}${suffix}`
      activeModelLine = `active model: ${formatAuthModelKey(modelAuth.auth)}`
    } else if (modelAuth.status === "invalid-config") {
      activeModelLine = "active model: none (invalid config)"
    } else {
      activeModelLine = "active model: none"
    }
  } catch {
    activeModelLine = "active model: unknown (auth check failed)"
  }

  const context = getUserMessageContext(getCurrentSessionMessages(ctx))
  const herdrLine = `herdr: ${process.env["HERDR_PANE_ID"]?.trim() ? "available" : "unavailable"}`
  const contextLine = `context: ${context?.count ?? 0} user messages`

  ctx.ui.notify(
    [
      "pi-rename status",
      selectedModelLine,
      activeModelLine,
      `language: ${state.language}`,
      herdrLine,
      contextLine,
    ].join("\n"),
    "info",
  )
}

export default function autoRename(pi: ExtensionAPI): void {
  const state = createRenameState()
  let pendingRename: ReturnType<typeof setTimeout> | undefined

  function cancelPendingRename(): void {
    if (pendingRename !== undefined) clearTimeout(pendingRename)
    pendingRename = undefined
  }

  function scheduleRename(): void {
    if (pendingRename !== undefined) return

    // pi stores a user message after message_end handlers return
    pendingRename = setTimeout(() => {
      pendingRename = undefined
      pi.sendUserMessage("/rename", {
        deliverAs: "followUp",
        expandPromptTemplates: true,
      })
    }, 0)
  }

  pi.registerCommand("rename", {
    description: "generate a session name",
    getArgumentCompletions: getRenameArgumentCompletions,
    handler: async (args, ctx) => {
      const [action = "", ...actionArgs] = args.trim().split(/\s+/u)
      const normalizedAction = action.toLowerCase()

      if (!normalizedAction) {
        cancelPendingRename()
        await runRenameCommand(pi, ctx, state)
        return
      }

      if (normalizedAction === "help") {
        ctx.ui.notify(
          [
            "pi-rename commands",
            "/rename - generate and apply a session name",
            "/rename status - show model and rename status",
            "/rename config - choose the rename model",
            "/rename config language <auto|BCP-47> - set name language",
            "/rename help - show this help",
          ].join("\n"),
          "info",
        )
        return
      }

      if (normalizedAction === "status") {
        await notifyRenameStatus(ctx, state)
        return
      }

      if (normalizedAction === "config") {
        const [setting, value, extra] = actionArgs
        if (!setting) {
          await configureRenameModel(ctx, state)
          return
        }

        if (setting.toLowerCase() === "language" && !extra) {
          configureRenameLanguage(ctx, state, value)
          return
        }

        ctx.ui.notify("Use /rename config language <auto|BCP-47>", "error")
        return
      }

      ctx.ui.notify("Use /rename [config|help|status]", "error")
    },
  })

  pi.on("session_start", async (event, ctx) => {
    cancelPendingRename()
    const initialConfig = resolveInitialRenameConfig()
    state.modelConfig = initialConfig.modelConfig
    state.language = initialConfig.language

    if (event.reason !== "reload" && hasUserContext(ctx)) {
      scheduleRename()
    }

    const sessionName = pi.getSessionName()?.trim()
    if (!sessionName) return

    try {
      await renameCurrentHerdrTargetIfDefault(sessionName)
    } catch {
      // keep startup quiet when herdr is unavailable
    }
  })

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "user" && !hasUserContext(ctx)) {
      scheduleRename()
    }
  })

  pi.on("session_tree", (_event, ctx) => {
    cancelPendingRename()
    if (hasUserContext(ctx)) scheduleRename()
  })

  pi.on("session_shutdown", () => {
    cancelPendingRename()
  })
}
