import assert from "node:assert/strict"
import test from "node:test"
import type { Api, AssistantMessage, Model, ModelsApiStreamOptions, StopReason } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { DEFAULT_RENAME_MODEL, type RenameModelConfig, type RenameModelPreference } from "../models.ts"
import { generateRename, type UserMessageContext } from "../naming.ts"

const models: RenameModelPreference[] = [
  { provider: "provider-a", id: "first" },
  { provider: "provider-b", id: "second" },
  { provider: "provider-c", id: "third" },
]
const config: RenameModelConfig = { kind: "configured", models }
const context: UserMessageContext = { first: "Fix initial bug", recent: ["Fix latest bug"], count: 2 }

function response(text: string, stopReason: StopReason = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], stopReason,
    api: "openai-responses", provider: "test", model: "test", timestamp: 0,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

function model(preference: RenameModelPreference): Model<Api> {
  return {
    ...preference, api: "openai-responses", name: preference.id, baseUrl: "https://example.invalid",
    reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

interface FixtureOptions {
  readonly missing?: readonly string[]
  readonly unauthenticated?: readonly string[]
  readonly authErrors?: readonly string[]
  readonly signal?: AbortSignal
  readonly onAuth?: () => void
  readonly onComplete?: () => void
  readonly preferences?: readonly RenameModelPreference[]
}

function fixture(outcomes: readonly (AssistantMessage | Error)[], options: FixtureOptions = {}) {
  const requests: string[] = []
  const authChecks: string[] = []
  const requestOptions: (ModelsApiStreamOptions<Api> | undefined)[] = []
  let inFlight = 0
  let maxInFlight = 0
  const ctx = {
    signal: options.signal,
    modelRegistry: {
      find(provider: string, id: string) {
        if (options.missing?.includes(provider)) return undefined
        const preference = (options.preferences ?? models).find((item) => item.provider === provider && item.id === id)
        return preference ? model(preference) : undefined
      },
      async getProviderAuth(provider: string) {
        authChecks.push(provider)
        options.onAuth?.()
        if (options.authErrors?.includes(provider)) throw new Error("auth refresh failed")
        return options.unauthenticated?.includes(provider) ? undefined : { auth: { apiKey: "test-key" } }
      },
      async complete(candidate: Model<Api>, _context: unknown, request?: ModelsApiStreamOptions<Api>) {
        requests.push(candidate.id)
        requestOptions.push(request)
        inFlight += 1
        maxInFlight = Math.max(inFlight, maxInFlight)
        await Promise.resolve()
        options.onComplete?.()
        inFlight -= 1
        const result = outcomes[requests.length - 1]
        if (result instanceof Error) throw result
        assert.ok(result, "unexpected extra completion request")
        return result
      },
    },
  } as unknown as ExtensionContext
  return { ctx, requests, authChecks, requestOptions, maxInFlight: () => maxInFlight }
}

test("stops on the first successful model without checking later authentication", async () => {
  const f = fixture([response("Fix Model Name")])
  assert.deepEqual(await generateRename(f.ctx, config, context, "en"), { source: "model", name: "fix-model-name" })
  assert.deepEqual(f.requests, ["first"])
  assert.deepEqual(f.authChecks, ["provider-a"])
  assert.equal(f.requestOptions[0]?.timeoutMs, 30_000)
  assert.equal(f.requestOptions[0]?.maxRetries, 0)
  assert.equal(f.requestOptions[0]?.maxTokens, 80)
  assert.equal(f.requestOptions[0]?.cacheRetention, "none")
})

test("tries models sequentially after request exceptions and stops on success", async () => {
  const f = fixture([new Error("provider failure"), response("use-second")])
  assert.deepEqual(await generateRename(f.ctx, config, context, "en"), { source: "model", name: "use-second" })
  assert.deepEqual(f.requests, ["first", "second"])
  assert.equal(f.maxInFlight(), 1)
})

for (const stopReason of ["error", "aborted", "length", "toolUse"] as const) {
  test(`tries the next model after a ${stopReason} response`, async () => {
    const f = fixture([response("ignored-name", stopReason), response("use-second")])
    assert.equal((await generateRename(f.ctx, config, context, "en"))?.name, "use-second")
    assert.deepEqual(f.requests, ["first", "second"])
  })
}

for (const text of ["", "   ", "!!!", "```\n```", "你好"]) {
  test(`tries the next model after an unusable English name: ${JSON.stringify(text)}`, async () => {
    const f = fixture([response(text), response("use-second")])
    assert.deepEqual(await generateRename(f.ctx, config, context, "en"), { source: "model", name: "use-second" })
    assert.deepEqual(f.requests, ["first", "second"])
  })
}

test("skips missing and unauthenticated models", async () => {
  const f = fixture([response("use-third")], { missing: ["provider-a"], unauthenticated: ["provider-b"] })
  assert.deepEqual(await generateRename(f.ctx, config, context, "en"), { source: "model", name: "use-third" })
  assert.deepEqual(f.requests, ["third"])
  assert.deepEqual(f.authChecks, ["provider-b", "provider-c"])
})

test("continues after authentication refresh errors", async () => {
  const f = fixture([response("use-second")], { authErrors: ["provider-a"] })
  assert.equal((await generateRename(f.ctx, config, context, "en"))?.name, "use-second")
  assert.deepEqual(f.requests, ["second"])
})

test("continues after a request timeout", async () => {
  const f = fixture([new DOMException("request timed out", "TimeoutError"), response("use-second")])
  assert.equal((await generateRename(f.ctx, config, context, "en"))?.name, "use-second")
  assert.deepEqual(f.requests, ["first", "second"])
})

test("uses the text fallback only after every model fails and reports all reasons", async () => {
  const f = fixture([response("", "error"), new Error("request failure"), response("")])
  const result = await generateRename(f.ctx, config, context, "en")
  assert.equal(result?.source, "fallback")
  assert.equal(result?.name, "fix-latest-bug")
  assert.deepEqual(f.requests, ["first", "second", "third"])
  assert.ok(result?.source === "fallback")
  assert.match(result.reason, /provider-a\/first: stopped with error/)
  assert.match(result.reason, /provider-b\/second: request failure/)
  assert.match(result.reason, /provider-c\/third: empty session name/)
})

test("all unavailable models reach the text fallback without a request", async () => {
  const f = fixture([], { missing: models.map((item) => item.provider) })
  assert.equal((await generateRename(f.ctx, config, context, "en"))?.source, "fallback")
  assert.deepEqual(f.requests, [])
})

test("invalid config goes directly to the text fallback", async () => {
  const f = fixture([])
  assert.deepEqual(await generateRename(f.ctx, { kind: "invalid" }, context, "en"), {
    source: "fallback", name: "fix-latest-bug", reason: "invalid rename model config",
  })
  assert.deepEqual(f.authChecks, [])
})

test("missing config tries the existing default model", async () => {
  const f = fixture([response("default-name")], { preferences: [DEFAULT_RENAME_MODEL] })
  assert.deepEqual(await generateRename(f.ctx, { kind: "missing" }, context, "en"), { source: "model", name: "default-name" })
  assert.deepEqual(f.requests, [DEFAULT_RENAME_MODEL.id])
})

test("returns undefined if both model and text fallback names are empty", async () => {
  const f = fixture([], { missing: models.map((item) => item.provider) })
  assert.equal(await generateRename(f.ctx, config, { first: "!!!", recent: [], count: 1 }, "en"), undefined)
})

test("preserves Unicode naming after a model failure", async () => {
  const f = fixture([new Error("failed"), response("修复错误")])
  assert.deepEqual(await generateRename(f.ctx, config, context, "zh"), { source: "model", name: "修复错误" })
})

test("cancellation before the sequence makes no auth checks or requests", async () => {
  const controller = new AbortController()
  controller.abort()
  const f = fixture([], { signal: controller.signal })
  assert.equal(await generateRename(f.ctx, config, context, "en"), undefined)
  assert.deepEqual(f.authChecks, [])
  assert.deepEqual(f.requests, [])
})

test("cancellation during authentication stops before completion", async () => {
  const controller = new AbortController()
  const f = fixture([], { signal: controller.signal, onAuth: () => controller.abort() })
  assert.equal(await generateRename(f.ctx, config, context, "en"), undefined)
  assert.deepEqual(f.requests, [])
})

for (const outcome of [response("cancelled-name"), new Error("aborted")]) {
  test(`cancellation during a request stops the sequence without a fallback (${outcome instanceof Error ? "throw" : "response"})`, async () => {
    const controller = new AbortController()
    const f = fixture([outcome], { signal: controller.signal, onComplete: () => controller.abort() })
    assert.equal(await generateRename(f.ctx, config, context, "en"), undefined)
    assert.deepEqual(f.requests, ["first"])
    assert.equal(f.requestOptions[0]?.signal, controller.signal)
  })
}
