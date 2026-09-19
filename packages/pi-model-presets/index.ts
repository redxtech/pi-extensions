import { join } from "node:path"
import {
  CustomEditor,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { matchesKey, type KeyId } from "@earendil-works/pi-tui"
import {
  loadConfig,
  THINKING_LEVELS,
  type ModelPreset,
  type ThinkingLevel,
} from "./config.ts"
import { decoratePresetCycling } from "./editor.ts"
import {
  configurationsMatch,
  getCycleTarget,
  type ActivePreset,
  type CurrentModelConfiguration,
  type CycleDirection,
} from "./state.ts"

const CONFIG_PATH = join(getAgentDir(), "model-presets.json")
const STATUS_KEY = "model-preset"
const STATE_ENTRY_TYPE = "model-preset-state"

interface PersistedPresetState {
  version: 1
  name: string | null
  provider?: string
  model?: string
  thinkingLevel?: ThinkingLevel
  configuredThinkingLevel?: ThinkingLevel | null
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string"
    && THINKING_LEVELS.includes(value as ThinkingLevel)
}

function findPreset(
  presets: ModelPreset[],
  name: string,
): ModelPreset | undefined {
  const normalizedName = name.toLowerCase()
  return presets.find(
    (preset) => preset.name.toLowerCase() === normalizedName,
  )
}

function getCurrentConfiguration(
  ctx: ExtensionContext,
  thinkingLevel: ThinkingLevel,
): CurrentModelConfiguration | undefined {
  if (!ctx.model) return undefined
  return {
    provider: ctx.model.provider,
    model: ctx.model.id,
    thinkingLevel,
  }
}

function formatPreset(preset: ModelPreset): string {
  return `${preset.name} · ${preset.provider}/${preset.model} · ${preset.thinkingLevel ?? "default"}`
}

function parsePersistedState(value: unknown): PersistedPresetState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  const state = value as Record<string, unknown>
  if (state.version !== 1) return undefined
  if (state.name === null) return { version: 1, name: null }
  if (
    typeof state.name !== "string"
    || typeof state.provider !== "string"
    || typeof state.model !== "string"
    || !isThinkingLevel(state.thinkingLevel)
    || (
      state.configuredThinkingLevel !== null
      && state.configuredThinkingLevel !== undefined
      && !isThinkingLevel(state.configuredThinkingLevel)
    )
  ) {
    return undefined
  }

  return {
    version: 1,
    name: state.name,
    provider: state.provider,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    configuredThinkingLevel: state.configuredThinkingLevel as
      | ThinkingLevel
      | null
      | undefined,
  }
}

export default function modelPresets(pi: ExtensionAPI): void {
  const { config, issues } = loadConfig(CONFIG_PATH)
  let activePreset: ActivePreset | undefined
  let applyingPreset = false
  let cleanupEditor: (() => void) | undefined
  let sessionGeneration = 0
  let cycleQueue: Promise<void> = Promise.resolve()

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return
    ctx.ui.setStatus(
      STATUS_KEY,
      config.ui.status && activePreset
        ? `preset:${activePreset.name}`
        : undefined,
    )
  }

  function report(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void {
    if (ctx.hasUI) {
      if (config.ui.notifications) ctx.ui.notify(message, level)
      return
    }

    if (level !== "info") console.error(message)
  }

  function persistActivePreset(active: ActivePreset): void {
    const state: PersistedPresetState = {
      version: 1,
      name: active.name,
      provider: active.provider,
      model: active.model,
      thinkingLevel: active.thinkingLevel,
      configuredThinkingLevel: active.configuredThinkingLevel ?? null,
    }
    pi.appendEntry(STATE_ENTRY_TYPE, state)
  }

  function clearActivePreset(
    ctx: ExtensionContext,
    persist: boolean,
  ): void {
    if (!activePreset) return
    activePreset = undefined
    if (persist) {
      pi.appendEntry(STATE_ENTRY_TYPE, {
        version: 1,
        name: null,
      } satisfies PersistedPresetState)
    }
    updateStatus(ctx)
  }

  function syncActivePreset(ctx: ExtensionContext): void {
    if (applyingPreset || !activePreset) return
    const current = getCurrentConfiguration(ctx, pi.getThinkingLevel())
    if (!configurationsMatch(activePreset, current)) {
      clearActivePreset(ctx, true)
    }
  }

  async function applyPreset(
    preset: ModelPreset,
    ctx: ExtensionContext,
    generation: number,
  ): Promise<boolean> {
    const model = ctx.modelRegistry.find(preset.provider, preset.model)
    if (!model) {
      report(
        ctx,
        `Preset "${preset.name}": model ${preset.provider}/${preset.model} was not found`,
        "error",
      )
      return false
    }

    applyingPreset = true
    try {
      const success = await pi.setModel(model)
      if (!success) {
        report(
          ctx,
          `Preset "${preset.name}": authentication is not configured for ${preset.provider}`,
          "error",
        )
        return false
      }
      if (generation !== sessionGeneration) return false

      if (preset.thinkingLevel) {
        pi.setThinkingLevel(preset.thinkingLevel)
      }

      const resolvedThinkingLevel = pi.getThinkingLevel()
      activePreset = {
        name: preset.name,
        provider: preset.provider,
        model: preset.model,
        thinkingLevel: resolvedThinkingLevel,
        ...(preset.thinkingLevel
          ? { configuredThinkingLevel: preset.thinkingLevel }
          : {}),
      }
      persistActivePreset(activePreset)
      updateStatus(ctx)
      report(
        ctx,
        `Preset "${preset.name}": ${preset.provider}/${preset.model} · ${resolvedThinkingLevel}${preset.thinkingLevel ? "" : " (default)"}`,
        "info",
      )
      return true
    } catch (error) {
      if (generation === sessionGeneration) {
        const message = error instanceof Error ? error.message : String(error)
        report(ctx, `Preset "${preset.name}" failed: ${message}`, "error")
      }
      return false
    } finally {
      applyingPreset = false
    }
  }

  function queueCycle(
    direction: CycleDirection,
    ctx: ExtensionContext,
    generation: number,
  ): void {
    cycleQueue = cycleQueue
      .then(async () => {
        if (generation !== sessionGeneration) return
        const current = getCurrentConfiguration(ctx, pi.getThinkingLevel())
        const target = getCycleTarget(
          config.presets,
          activePreset?.name,
          current,
          direction,
        )
        if (target) await applyPreset(target, ctx, generation)
      })
      .catch((error: unknown) => {
        if (generation !== sessionGeneration) return
        const message = error instanceof Error ? error.message : String(error)
        report(ctx, `Cannot cycle model presets: ${message}`, "error")
      })
  }

  function restoreActivePreset(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getBranch()
    let persisted: PersistedPresetState | undefined
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) {
        continue
      }
      persisted = parsePersistedState(entry.data)
      break
    }

    if (!persisted || persisted.name === null) return
    const preset = findPreset(config.presets, persisted.name)
    if (!preset) return
    if (
      preset.provider !== persisted.provider
      || preset.model !== persisted.model
      || (preset.thinkingLevel ?? null)
        !== (persisted.configuredThinkingLevel ?? null)
    ) {
      return
    }

    const restored: ActivePreset = {
      name: preset.name,
      provider: persisted.provider!,
      model: persisted.model!,
      thinkingLevel: persisted.thinkingLevel!,
      ...(preset.thinkingLevel
        ? { configuredThinkingLevel: preset.thinkingLevel }
        : {}),
    }
    const current = getCurrentConfiguration(ctx, pi.getThinkingLevel())
    if (configurationsMatch(restored, current)) activePreset = restored
  }

  function inputDirection(data: string): CycleDirection | undefined {
    if (config.presets.length === 0) return undefined

    try {
      if (
        config.keybindings.next
        && matchesKey(data, config.keybindings.next as KeyId)
      ) {
        return "forward"
      }
      if (
        config.keybindings.previous
        && matchesKey(data, config.keybindings.previous as KeyId)
      ) {
        return "backward"
      }
    } catch {
      return undefined
    }

    return undefined
  }

  pi.registerFlag("preset", {
    description: "Select a configured model preset",
    type: "string",
  })

  pi.registerCommand("preset", {
    description: "Select a configured model preset",
    getArgumentCompletions: (prefix) => {
      const normalizedPrefix = prefix.toLowerCase()
      const matches = config.presets
        .filter((preset) => preset.name.toLowerCase().startsWith(
          normalizedPrefix,
        ))
        .map((preset) => ({
          value: preset.name,
          label: preset.name,
          description: `${preset.provider}/${preset.model} · ${preset.thinkingLevel ?? "default"}`,
        }))
      return matches.length > 0 ? matches : null
    },
    handler: async (args, ctx) => {
      const generation = sessionGeneration
      const requestedName = args?.trim()
      if (requestedName) {
        const preset = findPreset(config.presets, requestedName)
        if (!preset) {
          report(
            ctx,
            `Unknown preset "${requestedName}". Available: ${config.presets.map((item) => item.name).join(", ") || "none"}`,
            "error",
          )
          return
        }
        await applyPreset(preset, ctx, generation)
        return
      }

      if (config.presets.length === 0) {
        report(ctx, `No presets are configured in ${CONFIG_PATH}`, "warning")
        return
      }
      if (!ctx.hasUI) {
        report(ctx, "The /preset selector requires an interactive session", "error")
        return
      }

      const choices = config.presets.map(formatPreset)
      const selected = await ctx.ui.select("Select model preset", choices)
      if (!selected || generation !== sessionGeneration) return
      const selectedIndex = choices.indexOf(selected)
      const preset = config.presets[selectedIndex]
      if (preset) await applyPreset(preset, ctx, generation)
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    sessionGeneration += 1
    const generation = sessionGeneration
    activePreset = undefined
    restoreActivePreset(ctx)
    updateStatus(ctx)

    for (const issue of issues) {
      report(ctx, `Model preset configuration: ${issue}`, "error")
    }

    if (ctx.mode === "tui") {
      const previousFactory = ctx.ui.getEditorComponent()
      ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
        cleanupEditor?.()
        const editor = previousFactory?.(tui, editorTheme, keybindings)
          ?? new CustomEditor(tui, editorTheme, keybindings)
        cleanupEditor = decoratePresetCycling(editor, {
          getDirection: inputDirection,
          isIdle: () => ctx.isIdle(),
          cycle: (direction) => queueCycle(direction, ctx, generation),
        })
        return editor
      })
    }

    const requestedPreset = pi.getFlag("preset")
    if (typeof requestedPreset !== "string" || requestedPreset.length === 0) {
      return
    }

    const preset = findPreset(config.presets, requestedPreset)
    if (!preset) {
      report(
        ctx,
        `Unknown preset "${requestedPreset}". Available: ${config.presets.map((item) => item.name).join(", ") || "none"}`,
        "error",
      )
      return
    }
    await applyPreset(preset, ctx, generation)
  })

  pi.on("model_select", async (_event, ctx) => {
    syncActivePreset(ctx)
  })

  pi.on("thinking_level_select", async (_event, ctx) => {
    syncActivePreset(ctx)
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionGeneration += 1
    cleanupEditor?.()
    cleanupEditor = undefined
    activePreset = undefined
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
