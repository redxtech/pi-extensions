import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import {
  DEFAULT_RENAME_LANGUAGE,
  parseRenameLanguage,
  type RenameLanguage,
} from "./language.ts"

const CONFIG_PATH = path.join(getAgentDir(), "extensions", "pi-rename.json")
const CONFIG_DIR = path.dirname(CONFIG_PATH)

export interface RenameModelPreference {
  readonly provider: string
  readonly id: string
}

interface RenameModelAuth {
  readonly model: Model<Api>
}

export type RenameModelConfig =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "configured"
      readonly models: readonly RenameModelPreference[]
    }

export type ResolvedRenameModelAuth =
  | {
      readonly status: "ok"
      readonly auth: RenameModelAuth
    }
  | {
      readonly status: "unauthenticated"
      readonly model: RenameModelPreference
    }

interface RenameConfig extends Record<string, unknown> {
  model?: unknown
  models?: unknown
  language?: unknown
}

export interface RenameState {
  modelConfig: RenameModelConfig
  language: RenameLanguage
}

export const DEFAULT_RENAME_MODEL: RenameModelPreference = {
  provider: "codex",
  id: "codex-proxy/gpt-6-luna",
}

export function createRenameState(): RenameState {
  return {
    modelConfig: { kind: "missing" },
    language: DEFAULT_RENAME_LANGUAGE,
  }
}

export function formatRenameModelKey({
  provider,
  id,
}: RenameModelPreference): string {
  return `${provider}/${id}`
}

export function formatAuthModelKey(auth: RenameModelAuth): string {
  return `${auth.model.provider}/${auth.model.id}`
}

export function formatModelPreference(config: RenameModelConfig): string {
  if (config.kind === "configured") {
    return config.models.map(formatRenameModelKey).join(" → ")
  }
  if (config.kind === "invalid") return "invalid"
  return "default"
}

export function parseModelSpec(
  value: string,
): RenameModelPreference | undefined {
  const trimmed = value.trim()
  const separator = trimmed.indexOf("/")
  if (separator <= 0 || separator === trimmed.length - 1) return undefined

  return {
    provider: trimmed.slice(0, separator),
    id: trimmed.slice(separator + 1),
  }
}

function readConfig(): RenameConfig {
  const content = readFileSync(CONFIG_PATH, "utf-8")
  const config = JSON.parse(content) as unknown
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as RenameConfig)
    : {}
}

function writeConfig(config: RenameConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8")
}

function readConfigForUpdate(): RenameConfig {
  if (!existsSync(CONFIG_PATH)) return {}

  try {
    return readConfig()
  } catch (error) {
    if (error instanceof SyntaxError) return {}
    throw error
  }
}

function updateConfig(update: Partial<RenameConfig>): void {
  writeConfig({ ...readConfigForUpdate(), ...update })
}

export function saveModelPreferences(
  models: readonly RenameModelPreference[],
): void {
  const keys = models.map(formatRenameModelKey)
  if (keys.length === 0 || keys.some((key) => !parseModelSpec(key))) {
    throw new Error("Rename models must be a non-empty list of provider/model IDs")
  }

  const config = readConfigForUpdate()
  delete config.model
  writeConfig({ ...config, models: keys })
}

export function saveRenameLanguage(language: RenameLanguage): void {
  updateConfig({ language })
}

export function deleteModelPreference(): void {
  if (!existsSync(CONFIG_PATH)) return

  const config = readConfigForUpdate()
  delete config.model
  delete config.models
  if (Object.keys(config).length === 0) {
    rmSync(CONFIG_PATH)
    return
  }

  writeConfig(config)
}

function resolveModelConfig(config: RenameConfig): RenameModelConfig {
  if (config.models === undefined && config.model === undefined) {
    return { kind: "missing" }
  }

  const values = config.models !== undefined ? config.models : [config.model]
  if (!Array.isArray(values) || values.length === 0) return { kind: "invalid" }

  const models: RenameModelPreference[] = []
  for (const value of values) {
    if (typeof value !== "string") return { kind: "invalid" }
    const model = parseModelSpec(value)
    if (!model) return { kind: "invalid" }
    models.push(model)
  }

  return { kind: "configured", models }
}

export function getRenameModelPreferences(
  config: RenameModelConfig,
): readonly RenameModelPreference[] {
  if (config.kind === "invalid") return []
  return config.kind === "configured" ? config.models : [DEFAULT_RENAME_MODEL]
}

export function resolveInitialRenameConfig(): RenameState {
  if (!existsSync(CONFIG_PATH)) return createRenameState()

  try {
    const config = readConfig()
    return {
      modelConfig: resolveModelConfig(config),
      language: parseRenameLanguage(config.language) ?? DEFAULT_RENAME_LANGUAGE,
    }
  } catch {
    return {
      modelConfig: { kind: "invalid" },
      language: DEFAULT_RENAME_LANGUAGE,
    }
  }
}

export async function getRenameModelAuth(
  ctx: ExtensionContext,
  preference: RenameModelPreference,
): Promise<ResolvedRenameModelAuth> {
  const model = ctx.modelRegistry.find(preference.provider, preference.id)
  if (model?.input.includes("text")) {
    const auth = await ctx.modelRegistry.getProviderAuth(model.provider)
    if (auth?.auth.apiKey) return { status: "ok", auth: { model } }
  }

  return { status: "unauthenticated", model: preference }
}

export async function getAuthenticatedTextModels(
  ctx: ExtensionContext,
): Promise<RenameModelPreference[]> {
  const models = ctx.modelRegistry
    .getAll()
    .filter((model) => model.input.includes("text"))
  const authenticatedModels = await Promise.all(
    models.map(async (model) => {
      const auth = await ctx.modelRegistry.getProviderAuth(model.provider)
      return auth?.auth.apiKey
        ? { provider: model.provider, id: model.id }
        : undefined
    }),
  )

  return authenticatedModels
    .filter((model): model is RenameModelPreference => model !== undefined)
    .toSorted((left, right) =>
      formatRenameModelKey(left).localeCompare(formatRenameModelKey(right)),
    )
}
