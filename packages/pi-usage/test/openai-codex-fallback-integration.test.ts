import assert from "node:assert/strict";
import { test } from "node:test";
import usageExtension from "../src/usage.ts";
import { createOpenAICodexUsagePairing, resolveOpenAICodexFallback } from "../src/openai-codex-fallback.ts";
import { DEFAULT_USAGE_SETTINGS, type UsageSettingsRuntime, type UsageSettingsState } from "../src/settings.ts";
import { formatProviderStates, formatUsageReport, formatUsageStatusline } from "../src/format.ts";
import { normalizeCodexBackendPayload } from "../src/providers/codex.ts";
import { createMockContext, createMockPi } from "./support.ts";

const jwt = (claims: object) => `mock.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.mock`;
const openaiClaims = { iss: "https://auth.example", sub: "new-subject", client_id: "new-client" };
const codexClaims = { iss: "https://auth.example", sub: "old-subject",
  "https://api.openai.com/auth": { chatgpt_account_id: "mock-account" } };
const payload = { account_id: "mock-account", rate_limit: { primary_window: {
  used_percent: 20, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1_000) + 600,
} }, rate_limit_reset_credits: { available_count: 2 } };

function harness(t: { after(fn: () => unknown): void }, enabled = true) {
  const originalFetch = globalThis.fetch;
  const mock = createMockPi();
  const openaiModel = { provider: "openai", id: "openai-sub/gpt-6.1-sol", name: "Current model",
    baseUrl: "http://proxy.example/v1", api: "openai-responses" };
  const codexModel = { provider: "openai-codex", id: "openai-sub-legacy/gpt-5.4", name: "Legacy model",
    baseUrl: "http://proxy.example", api: "openai-codex-responses" };
  const credentials: Record<string, Record<string, unknown>> = {
    openai: { type: "oauth", access: jwt(openaiClaims), refresh: "mock-new-refresh", expires: 1_900_000_000_000,
      scope: "chatgpt.tokens.use.direct" },
    "openai-codex": { type: "oauth", access: jwt(codexClaims), refresh: "mock-old-refresh", expires: 1_900_000_000_000,
      accountId: "mock-account" },
  };
  let source = "oauth";
  let sessionId = "session-a";
  let legacyResolutions = 0;
  let onLegacyResolve = (_count: number) => {};
  let onFetch = async () => {};
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const screens: Array<{ title: string; options: string[] }> = [];
  const selections: string[] = [];
  let confirmations = 0;
  let onConfirm = async () => true;
  let revision = 0;
  let state: UsageSettingsState = { kind: "loaded", path: "/mock/pi-usage.json", settings: {
    ...DEFAULT_USAGE_SETTINGS, selectedTargets: {}, openaiCodexUsageFallback: enabled,
  } };
  const runtime: UsageSettingsRuntime = {
    get: () => structuredClone({ ...state, fallbackRevision: revision }),
    reload: async () => runtime.get(),
    update: async (patch, signal, beforePublish) => {
      await beforePublish?.();
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      state = { ...state, settings: { ...state.settings, ...patch } };
      revision += 1;
      return runtime.get();
    },
    updateSelectedTarget: async () => runtime.get(),
    flush: async () => {},
  };
  const reader = (provider: string) => credentials[provider];
  const registry = {
    getProvider: (provider: string) => ({ baseUrl: provider === "openai" ? openaiModel.baseUrl : codexModel.baseUrl }),
    getProviderAuth: async (provider: string) => ({ source: provider === "openai" ? source : "oauth",
      auth: { apiKey: credentials[provider]?.access, baseUrl: provider === "openai" ? openaiModel.baseUrl : codexModel.baseUrl } }),
    getApiKeyAndHeaders: async (model: { provider: string; baseUrl: string }) => {
      if (model.provider === "openai-codex") onLegacyResolve(++legacyResolutions);
      return { ok: true, apiKey: credentials[model.provider]?.access,
        headers: { Authorization: `Bearer ${credentials[model.provider]?.access}`, "X-Proxy-Key": "mock-proxy-key" },
        baseUrl: model.baseUrl };
    },
    getAvailable: () => [openaiModel, codexModel], getAll: () => [openaiModel, codexModel],
    getProviderDisplayName: (provider: string) => provider,
    getProviderAuthStatus: () => ({ configured: true }),
  };
  const { ctx: mockContext, statuses, notifications } = createMockContext({ model: openaiModel, mode: "rpc", hasUI: true,
    modelRegistry: registry, sessionManager: { getSessionId: () => sessionId },
    select: async (title: string, options: string[]) => {
      screens.push({ title, options });
      const selected = selections.shift() ?? "Close";
      return options.find((option) => option.startsWith(selected));
    },
    confirm: async (_title: string, message: string) => {
      confirmations += 1;
      assert.match(message, /same ChatGPT account and workspace/u);
      assert.match(message, /Automatic verification is unavailable/u);
      assert.match(message, /does not measure this app's cap/u);
      return onConfirm();
    },
  });
  const ctx = mockContext as { model: typeof openaiModel };
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    await onFetch();
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  usageExtension(mock.pi, { credentialReader: reader, settingsRuntime: runtime });
  t.after(() => { mock.events.get("session_shutdown")?.[0]?.({}, ctx); globalThis.fetch = originalFetch; });
  const settle = async () => { for (let i = 0; i < 100; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const event = async (name = "turn_start") => { mock.events.get(name)?.[0]?.({ model: ctx.model }, ctx); await settle(); };
  const pair = async () => {
    const resolution = await resolveOpenAICodexFallback(ctx as never, codexModel as never, { credentialReader: reader });
    await runtime.update({ openaiCodexUsagePairing: createOpenAICodexUsagePairing(
      resolution.openaiIdentityHash, resolution.codexIdentityHash) });
    legacyResolutions = 0;
  };
  return { ctx, statuses, notifications, mock, runtime, credentials, requests, screens, selections, openaiModel,
    codexModel, event, pair, settle, menu: () => mock.commands.get("usage")!.handler("", ctx),
    start: () => mock.events.get("session_start")?.[0]?.({}, ctx),
    confirmations: () => confirmations, legacyResolutions: () => legacyResolutions,
    source: (value: string) => { source = value; },
    session: (value: string) => { sessionId = value; },
    onConfirm: (fn: () => Promise<boolean>) => { onConfirm = fn; },
    onFetch: (fn: () => Promise<void>) => { onFetch = fn; },
    onLegacyResolve: (fn: (count: number) => void) => { onLegacyResolve = fn; },
  };
}

test("disabled OpenAI fallback is unsupported and never resolves legacy auth or fetches", async (t) => {
  const h = harness(t, false);
  await h.start(); await h.event(); await h.menu();
  assert.equal(h.requests.length, 0);
  assert.equal(h.legacyResolutions(), 0);
  assert.equal(h.confirmations(), 0);
  assert.match(h.screens[0]!.title, /Unsupported/u);
  assert.equal(h.statuses.get("usage"), undefined);
});

test("enabled unpaired refresh shows pairing required without prompting or resolving legacy auth", async (t) => {
  const h = harness(t);
  await h.start(); await h.event();
  assert.equal(h.statuses.get("usage"), "codex fallback pairing required");
  await h.menu();
  assert.ok(h.screens[0]!.options.some((option) => option.startsWith("Pair Codex fallback")));
  assert.equal(h.legacyResolutions(), 0);
  assert.equal(h.confirmations(), 0);
  assert.equal(h.requests.length, 0);
});

test("canceling explicit fallback confirmation neither persists pairing nor requests usage", async (t) => {
  const h = harness(t);
  h.selections.push("Pair Codex fallback", "Close");
  h.onConfirm(async () => false);
  await h.menu();
  assert.equal(h.confirmations(), 1);
  assert.equal(h.runtime.get().settings.openaiCodexUsagePairing, undefined);
  assert.equal(h.requests.length, 0);
});

test("explicit confirmation pairs both HTTP proxy providers and uses only fixed HTTPS Codex headers", async (t) => {
  const h = harness(t);
  h.selections.push("Pair Codex fallback", "Close");
  await h.menu();
  const pairing = h.runtime.get().settings.openaiCodexUsagePairing!;
  assert.match(pairing.openaiIdentityHash, /^[a-f0-9]{64}$/u);
  assert.match(pairing.codexIdentityHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(pairing).sort(), ["codexIdentityHash", "openaiIdentityHash", "version"]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(h.requests[0]!.init?.redirect, "error");
  assert.deepEqual(h.requests[0]!.init?.headers, { Authorization: `Bearer ${h.credentials["openai-codex"]!.access}`,
    "chatgpt-account-id": "mock-account" });
  assert.match(h.statuses.get("usage")!, /^codex fallback 80%/u);
  assert.match(h.screens.at(-1)!.title, /Codex fallback usage/u);
  assert.match(h.screens.at(-1)!.title, /does not measure this app's cap/u);
  assert.ok(h.screens.at(-1)!.options.every((option) => !/Fast mode|Redeem usage/u.test(option)));
  assert.equal(h.ctx.model, h.openaiModel);
  assert.equal(h.mock.setModels.length, 0);
});

for (const change of ["session", "model", "settings", "openai-identity", "codex-identity"] as const) {
  test(`confirmation rejects ${change} replacement before persistence or network`, async (t) => {
    const h = harness(t);
    h.selections.push("Pair Codex fallback", "Close");
    h.onConfirm(async () => {
      if (change === "session") h.session("session-b");
      if (change === "model") Object.assign(h.ctx, { model: { ...h.openaiModel, id: "other-model" } });
      if (change === "settings") await h.runtime.update({ openaiCodexUsageFallback: false });
      if (change === "openai-identity") h.credentials.openai!.access = jwt({ ...openaiClaims, sub: "changed" });
      if (change === "codex-identity") h.credentials["openai-codex"]!.access = jwt({ ...codexClaims, sub: "changed" });
      return true;
    });
    await h.menu();
    assert.equal(h.runtime.get().settings.openaiCodexUsagePairing, undefined);
    assert.equal(h.requests.length, 0);
  });
}

for (const change of ["missing-legacy", "api-key", "missing-scope", "malformed-identity", "changed-openai", "changed-codex"] as const) {
  test(`paired fallback fails closed for ${change} and does not reuse a cached report`, async (t) => {
    const h = harness(t);
    await h.pair(); await h.start(); await h.event();
    assert.equal(h.requests.length, 1);
    if (change === "missing-legacy") delete h.credentials["openai-codex"];
    if (change === "api-key") h.source("api_key");
    if (change === "missing-scope") delete h.credentials.openai!.scope;
    if (change === "malformed-identity") h.credentials.openai!.access = "malformed";
    if (change === "changed-openai") h.credentials.openai!.access = jwt({ ...openaiClaims, client_id: "changed" });
    if (change === "changed-codex") h.credentials["openai-codex"]!.access = jwt({ ...codexClaims, sub: "changed" });
    await h.event();
    assert.equal(h.requests.length, 1);
    assert.doesNotMatch(h.statuses.get("usage") ?? "", /80%/u);
    assert.match(h.statuses.get("usage") ?? "", /pairing required|auth unavailable/u);
  });
}

for (const provider of ["openai", "openai-codex"]) {
  test(`${provider} token rotation at the request boundary blocks the request`, async (t) => {
    const h = harness(t);
    await h.pair(); await h.start();
    h.onLegacyResolve((count) => {
      if (count === 2) h.credentials[provider]!.access = jwt({ ...(provider === "openai" ? openaiClaims : codexClaims), jti: "rotated" });
    });
    await h.event();
    assert.equal(h.requests.length, 0);
    assert.doesNotMatch(h.statuses.get("usage") ?? "", /80%/u);
  });
  test(`${provider} token rotation after fetch prevents publication`, async (t) => {
    const h = harness(t);
    await h.pair(); await h.start();
    h.onFetch(async () => { h.credentials[provider]!.access = jwt({ ...(provider === "openai" ? openaiClaims : codexClaims), jti: "rotated" }); });
    await h.event();
    assert.equal(h.requests.length, 1);
    assert.doesNotMatch(h.statuses.get("usage") ?? "", /80%/u);
  });
}

for (const change of ["disable", "remove", "replace", "session", "model", "missing-scope"] as const) {
  test(`inflight ${change} invalidates fallback cache and publication`, async (t) => {
    const h = harness(t);
    await h.pair(); await h.start();
    h.onFetch(async () => {
      if (change === "disable") await h.runtime.update({ openaiCodexUsageFallback: false });
      if (change === "remove") await h.runtime.update({ openaiCodexUsagePairing: undefined });
      if (change === "replace") await h.runtime.update({ openaiCodexUsagePairing: h.runtime.get().settings.openaiCodexUsagePairing });
      if (change === "session") h.session("session-b");
      if (change === "model") Object.assign(h.ctx, { model: { ...h.openaiModel, id: "different" } });
      if (change === "missing-scope") delete h.credentials.openai!.scope;
    });
    await h.event();
    assert.equal(h.requests.length, 1);
    assert.doesNotMatch(h.statuses.get("usage") ?? "", /80%/u);
  });
}

test("normal refresh retains identity pairing and cache while session reload preserves pairing", async (t) => {
  const h = harness(t);
  await h.pair(); await h.start(); await h.event();
  const pairing = h.runtime.get().settings.openaiCodexUsagePairing;
  h.credentials.openai!.access = jwt({ ...openaiClaims, jti: "refresh" });
  h.credentials["openai-codex"]!.access = jwt({ ...codexClaims, jti: "refresh" });
  await h.event();
  assert.equal(h.requests.length, 1);
  assert.match(h.statuses.get("usage")!, /80%/u);
  await h.start(); await h.event();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.runtime.get().settings.openaiCodexUsagePairing, pairing);
});

test("fallback labels select proxy-prefixed model buckets and honor reset countdown", () => {
  const report = { ...normalizeCodexBackendPayload({ ...payload, additional_rate_limits: [{
    metered_feature: "gpt-6.1-sol", limit_name: "Sol", rate_limit: {
      primary_window: { used_percent: 55, reset_at: 600, limit_window_seconds: 18_000 },
    },
  }] }, 0), providerId: "openai", fallback: { kind: "openai-codex" as const, sourceProviderId: "openai-codex" as const } };
  const model = { provider: "openai", id: "openai-sub/gpt-6.1-sol", name: "Sol" };
  assert.equal(formatUsageStatusline(report, model, 0, false), "codex fallback sol 45% 5h");
  assert.equal(formatUsageStatusline(report, model, 0, true), "codex fallback sol 45% ↻ 10m");
  assert.match(formatUsageReport(report, "current"), /Codex fallback usage/u);
  assert.equal(formatUsageStatusline(report, model, 0, false, false), "codex sol 45% 5h");
  assert.equal(formatUsageStatusline(report, model, 0, true, false), "codex sol 45% ↻ 10m");
  assert.match(formatUsageReport(report, "current", false), /^OpenAI · Codex usage/u);
  const state = { providerId: "openai", providerName: "OpenAI", displayState: "current" as const,
    status: "ready" as const, report };
  assert.match(formatProviderStates([state]), /Codex fallback usage/u);
  assert.match(formatProviderStates([state], false), /^OpenAI · Codex usage/u);
  const legacy = normalizeCodexBackendPayload(payload, 0);
  assert.equal(formatUsageStatusline(legacy, undefined, 0, false, false),
    formatUsageStatusline(legacy, undefined, 0, false));
});

test("label opt-out hides usage labels without changing pairing or the app-cap warning", async (t) => {
  const h = harness(t);
  await h.runtime.update({ showOpenaiCodexUsageFallbackLabel: false });
  await h.pair();
  const pairing = h.runtime.get().settings.openaiCodexUsagePairing;
  await h.start(); await h.event(); await h.menu();
  assert.match(h.statuses.get("usage")!, /^codex 80%/u);
  assert.doesNotMatch(h.statuses.get("usage")!, /fallback/u);
  assert.match(h.screens.at(-1)!.title, /OpenAI · Codex usage/u);
  assert.doesNotMatch(h.screens.at(-1)!.title, /Codex fallback usage/u);
  assert.match(h.screens.at(-1)!.title, /does not measure this app's cap/u);
  assert.deepEqual(h.runtime.get().settings.openaiCodexUsagePairing, pairing);
  assert.equal(h.requests.length, 1);
  assert.equal(h.confirmations(), 0);
  assert.ok(h.screens.at(-1)!.options.some((option) => option.startsWith("Re-pair Codex fallback")));
});

test("label opt-out does not bypass the pairing-required state or request legacy usage", async (t) => {
  const h = harness(t);
  await h.runtime.update({ showOpenaiCodexUsageFallbackLabel: false });
  await h.start(); await h.event(); await h.menu();
  assert.equal(h.statuses.get("usage"), "codex fallback pairing required");
  assert.equal(h.requests.length, 0);
  assert.equal(h.legacyResolutions(), 0);
  assert.equal(h.confirmations(), 0);
});

for (const provider of ["openai", "openai-codex"]) {
  for (const boundary of [7, 8]) {
    test(`${provider} rotation at publication boundary ${boundary} cannot publish or retain cached usage`, async (t) => {
      const h = harness(t);
      await h.pair(); await h.start();
      h.onLegacyResolve((count) => {
        if (count === boundary) h.credentials[provider]!.access = jwt({ ...(provider === "openai" ? openaiClaims : codexClaims), jti: "rotated" });
      });
      await h.event();
      assert.equal(h.requests.length, 1);
      assert.doesNotMatch(h.statuses.get("usage") ?? "", /80%/u);
      h.onLegacyResolve(() => {});
      await h.event();
      assert.equal(h.requests.length, 2);
      assert.match(h.statuses.get("usage") ?? "", /80%/u);
    });
  }
}

test("active API-key and malformed settings reject opt-in without resolving legacy auth", async (t) => {
  const h = harness(t);
  h.source("api_key");
  await h.start(); await h.event(); await h.menu();
  assert.equal(h.legacyResolutions(), 0);
  assert.equal(h.requests.length, 0);
  assert.ok(h.screens[0]!.options.every((option) => !option.startsWith("Pair Codex")));
});

test("missing legacy credentials prevent explicit pairing without usage network", async (t) => {
  const h = harness(t);
  delete h.credentials["openai-codex"];
  h.selections.push("Pair Codex fallback", "Close");
  await h.menu();
  assert.equal(h.confirmations(), 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.runtime.get().settings.openaiCodexUsagePairing, undefined);
});

test("fallback response account mismatch fails without publishing usage or an account ID", async (t) => {
  const h = harness(t);
  await h.pair(); await h.start();
  globalThis.fetch = async () => new Response(JSON.stringify({ ...payload, account_id: "other-mock-account" }), { status: 200 });
  await h.event(); await h.menu();
  assert.doesNotMatch(h.statuses.get("usage") ?? "", /80%|other-mock-account|mock-account/u);
  assert.doesNotMatch(h.screens.map((screen) => screen.title).join("\n"), /other-mock-account|mock-account/u);
});

test("explicit re-pair replaces persisted confirmation and removal clears cached fallback", async (t) => {
  const h = harness(t);
  await h.pair(); await h.start(); await h.event();
  const prior = h.runtime.get().settings.openaiCodexUsagePairing;
  h.credentials["openai-codex"]!.access = jwt({ ...codexClaims, sub: "replacement-subject" });
  h.selections.push("Re-pair Codex fallback", "Close");
  await h.menu();
  assert.equal(h.confirmations(), 1);
  assert.notDeepEqual(h.runtime.get().settings.openaiCodexUsagePairing, prior);
  assert.equal(h.requests.length, 2);
  h.selections.push("Remove Codex fallback pairing", "Close");
  await h.menu();
  assert.equal(h.runtime.get().settings.openaiCodexUsagePairing, undefined);
  assert.equal(h.statuses.get("usage"), "codex fallback pairing required");
  assert.equal(h.requests.length, 2);
});
