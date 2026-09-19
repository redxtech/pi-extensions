import { readFileSync } from "node:fs"

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export interface ModelPreset {
  name: string
  provider: string
  model: string
  thinkingLevel?: ThinkingLevel
}

export interface ModelPresetConfig {
  presets: ModelPreset[]
  keybindings: {
    next: string | null
    previous: string | null
  }
  ui: {
    status: boolean
    notifications: boolean
  }
}

export interface ConfigResult {
  config: ModelPresetConfig
  issues: string[]
}

const DEFAULT_CONFIG: ModelPresetConfig = {
  presets: [],
  keybindings: {
    next: "tab",
    previous: "shift+tab",
  },
  ui: {
    status: true,
    notifications: true,
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readNonEmptyString(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string`)
    return undefined
  }

  return value.trim()
}

function readKeybinding(
  value: unknown,
  fallback: string,
  path: string,
  issues: string[],
): string | null {
  if (value === undefined) return fallback
  if (value === null) return null
  return readNonEmptyString(value, path, issues) ?? fallback
}

function readBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
  issues: string[],
): boolean {
  if (value === undefined) return fallback
  if (typeof value === "boolean") return value
  issues.push(`${path} must be a boolean`)
  return fallback
}

function parsePreset(
  value: unknown,
  index: number,
  issues: string[],
): ModelPreset | undefined {
  const path = `presets[${index}]`
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`)
    return undefined
  }

  const name = readNonEmptyString(value.name, `${path}.name`, issues)
  const provider = readNonEmptyString(
    value.provider,
    `${path}.provider`,
    issues,
  )
  const model = readNonEmptyString(value.model, `${path}.model`, issues)

  let thinkingLevel: ThinkingLevel | undefined
  let hasValidThinkingLevel = true
  if (value.thinkingLevel !== undefined) {
    if (
      typeof value.thinkingLevel !== "string"
      || !THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel)
    ) {
      issues.push(
        `${path}.thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`,
      )
      hasValidThinkingLevel = false
    } else {
      thinkingLevel = value.thinkingLevel as ThinkingLevel
    }
  }

  if (!name || !provider || !model || !hasValidThinkingLevel) return undefined

  return {
    name,
    provider,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  }
}

export function parseConfig(value: unknown): ConfigResult {
  const issues: string[] = []
  if (!isRecord(value)) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      issues: ["configuration must be a JSON object"],
    }
  }

  const rawPresets = value.presets
  if (!Array.isArray(rawPresets)) {
    issues.push("presets must be an array")
  }

  const presets: ModelPreset[] = []
  const names = new Set<string>()
  for (const [index, rawPreset] of (Array.isArray(rawPresets)
    ? rawPresets
    : []).entries()) {
    const preset = parsePreset(rawPreset, index, issues)
    if (!preset) continue

    const normalizedName = preset.name.toLowerCase()
    if (names.has(normalizedName)) {
      issues.push(`preset name "${preset.name}" must be unique`)
      continue
    }

    names.add(normalizedName)
    presets.push(preset)
  }

  const rawKeybindings = value.keybindings
  if (rawKeybindings !== undefined && !isRecord(rawKeybindings)) {
    issues.push("keybindings must be an object")
  }
  const keybindings = isRecord(rawKeybindings) ? rawKeybindings : {}
  const next = readKeybinding(
    keybindings.next,
    DEFAULT_CONFIG.keybindings.next!,
    "keybindings.next",
    issues,
  )
  let previous = readKeybinding(
    keybindings.previous,
    DEFAULT_CONFIG.keybindings.previous!,
    "keybindings.previous",
    issues,
  )
  if (
    next !== null
    && previous !== null
    && next.toLowerCase() === previous.toLowerCase()
  ) {
    issues.push("keybindings.next and keybindings.previous must differ")
    previous = null
  }

  const rawUi = value.ui
  if (rawUi !== undefined && !isRecord(rawUi)) {
    issues.push("ui must be an object")
  }
  const ui = isRecord(rawUi) ? rawUi : {}

  return {
    config: {
      presets,
      keybindings: { next, previous },
      ui: {
        status: readBoolean(
          ui.status,
          DEFAULT_CONFIG.ui.status,
          "ui.status",
          issues,
        ),
        notifications: readBoolean(
          ui.notifications,
          DEFAULT_CONFIG.ui.notifications,
          "ui.notifications",
          issues,
        ),
      },
    },
    issues,
  }
}

export function loadConfig(path: string): ConfigResult {
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      config: structuredClone(DEFAULT_CONFIG),
      issues: [`cannot read ${path}: ${message}`],
    }
  }
}
