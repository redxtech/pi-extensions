import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Message } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { RenameLanguage } from "./language.ts"
import {
  formatRenameModelKey,
  getRenameModelAuth,
  getRenameModelPreferences,
  type RenameModelConfig,
} from "./models.ts"

const MAX_RENAME_CHARS = 30
const RENAME_MAX_TOKENS = 80
const RENAME_REQUEST_TIMEOUT_MS = 30_000

const RENAME_SYSTEM_PROMPT = `Name this coding-agent session.

Return one lowercase hyphen-separated session name only.
Use plain text, no quotes, no markdown, no trailing punctuation.
Prefer an action-oriented task name like fix-auth-callback or design-pi-rename.
Stay under 30 characters.`

export interface UserMessageContext {
  readonly first: string
  readonly recent: string[]
  readonly count: number
}

export type RenameResult =
  | { readonly source: "model"; readonly name: string }
  | {
      readonly source: "fallback"
      readonly name: string
      readonly reason: string
    }

function redactSecrets(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      "[redacted private key]",
    )
    .replace(/AKIA[0-9A-Z]{16}/gu, "[redacted aws key]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, "[redacted api key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/giu, "Bearer [redacted]")
    .replace(
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*([^\s'"]+)/giu,
      "$1=[redacted]",
    )
}

function sanitizeRenameText(raw: string, language = "en"): string {
  const allowUnicode = !/^en(?:-|$)/iu.test(language)
  const disallowedCharacters = allowUnicode
    ? /[^\p{L}\p{M}\p{N}]+/gu
    : /[^a-z0-9]+/giu

  return Array.from(
    raw
      .trim()
      .replace(/^```(?:\w+)?/u, "")
      .replace(/```$/u, "")
      .replace(/^name\s*:\s*/iu, "")
      .replace(/^title\s*:\s*/iu, "")
      .replace(/^[-*•]\s*/u, "")
      .replace(/["'`]/gu, "")
      .replace(disallowedCharacters, "-")
      .replace(/-+/gu, "-")
      .replace(/^-|-$/gu, "")
      .toLowerCase(),
  )
    .slice(0, MAX_RENAME_CHARS)
    .join("")
    .replace(/-$/u, "")
}

function extractTextContent(
  content:
    | string
    | readonly { readonly type: string; readonly text?: string }[],
): string {
  if (typeof content === "string") return content

  return content
    .filter(
      (item): item is { readonly type: string; readonly text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n")
}

function hasTextContent(message: AgentMessage): message is AgentMessage & {
  content: string | readonly { readonly type: string; readonly text?: string }[]
} {
  return "content" in message
}

export function getUserMessageContext(
  messages: readonly AgentMessage[],
): UserMessageContext | undefined {
  const userMessages: { index: number; text: string }[] = []

  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" || !hasTextContent(message)) continue

    const text = redactSecrets(extractTextContent(message.content)).trim()
    if (text) userMessages.push({ index, text })
  }

  const firstMessage = userMessages[0]
  if (!firstMessage) return undefined

  const recentMessages = userMessages
    .slice(-3)
    .filter((message) => message.index !== firstMessage.index)

  return {
    first: firstMessage.text,
    recent: recentMessages.map((message) => message.text),
    count: 1 + recentMessages.length,
  }
}

function buildRenamePrompt(context: UserMessageContext): Message {
  const recent = context.recent.length
    ? context.recent
        .map((message, index) => `${index + 1}. ${message}`)
        .join("\n")
    : "none"

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `## Naming context\n\nFirst user message:\n${context.first}\n\nRecent user messages:\n${recent}`,
      },
    ],
    timestamp: Date.now(),
  }
}

function buildRenameSystemPrompt(language: RenameLanguage): string {
  if (/^en(?:-|$)/iu.test(language)) return RENAME_SYSTEM_PROMPT

  const languageInstruction =
    language === "auto"
      ? "Use language of latest user message."
      : `Use language identified by BCP 47 tag ${language}.`

  return `Name this coding-agent session.

${languageInstruction}
Return one hyphen-separated session name only.
Use plain text, no quotes, no markdown, no trailing punctuation.
Use lowercase when selected language has case.
Prefer an action-oriented task name.
Stay under 60 characters.`
}

function fallbackRenameName(
  context: UserMessageContext,
  language: RenameLanguage,
): string | undefined {
  const latest = context.recent.at(-1) ?? context.first
  return sanitizeRenameText(latest, language)
}

export async function generateRename(
  ctx: ExtensionContext,
  modelConfig: RenameModelConfig,
  context: UserMessageContext,
  language: RenameLanguage,
): Promise<RenameResult | undefined> {
  const reasons: string[] = []
  if (modelConfig.kind === "invalid") reasons.push("invalid rename model config")

  for (const preference of getRenameModelPreferences(modelConfig)) {
    if (ctx.signal?.aborted) return undefined
    const modelKey = formatRenameModelKey(preference)

    try {
      const modelAuth = await getRenameModelAuth(ctx, preference)
      if (ctx.signal?.aborted) return undefined
      if (modelAuth.status !== "ok") {
        reasons.push(`${modelKey}: unavailable or not authenticated`)
        continue
      }

      const response = await ctx.modelRegistry.complete(
        modelAuth.auth.model,
        {
          systemPrompt: buildRenameSystemPrompt(language),
          messages: [buildRenamePrompt(context)],
        },
        {
          maxTokens: RENAME_MAX_TOKENS,
          maxRetries: 0,
          cacheRetention: "none",
          timeoutMs: RENAME_REQUEST_TIMEOUT_MS,
          signal: ctx.signal,
        },
      )
      if (ctx.signal?.aborted) return undefined

      if (response.stopReason === "stop") {
        const name = sanitizeRenameText(
          extractTextContent(response.content),
          language,
        )
        if (name) return { source: "model", name }
        reasons.push(`${modelKey}: empty session name`)
      } else {
        reasons.push(`${modelKey}: stopped with ${response.stopReason}`)
      }
    } catch (error) {
      if (ctx.signal?.aborted) return undefined
      const reason = error instanceof Error ? error.message : String(error)
      reasons.push(`${modelKey}: ${reason}`)
    }
  }

  if (ctx.signal?.aborted) return undefined
  const name = fallbackRenameName(context, language)
  return name
    ? { source: "fallback", name, reason: reasons.join("\n") }
    : undefined
}
