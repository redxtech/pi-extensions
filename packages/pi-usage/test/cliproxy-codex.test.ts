import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createMockContext, createMockPi } from "./support.ts";
import { vi } from "./vi-shim.ts";
import { adapterForProvider, queryProviderUsage, resolveReadOnlyUsageAuth, resolveUsageAuth } from "../src/query.ts";
import { resolveCLIProxyCodexAuth } from "../src/providers/cliproxy-codex.ts";
import { listUsageTargets, resolveUsageTarget } from "../src/usage-targets.ts";
import { formatUsageReport, formatUsageStatusline } from "../src/format.ts";
import { codexFastAvailability, rewriteCodexFastPayload } from "../src/codex-fast.ts";
import { resolveCodexResetAuth } from "../src/codex-resets.ts";
import { DEFAULT_USAGE_SETTINGS, type UsageSettingsRuntime, type UsageSettingsState } from "../src/settings.ts";
import type { PiModel } from "../src/types.ts";
import usageExtension from "../src/usage.ts";

const model = { id: "codex-proxy/gpt-5.5", name: "GPT 5.5 proxy", provider: "codex",
  baseUrl: "http://aperture.colobus-pirate.ts.net/v1" } as PiModel;
const env = { CLIPROXYAPI_MANAGEMENT_URL: "http://proxy.example.test:8317", CLIPROXYAPI_MANAGEMENT_KEY: "management-test-key" };
const salt = new Uint8Array([1, 2, 3]);
const signal = new AbortController().signal;
const guard = async () => undefined;
const adapter = adapterForProvider("codex")!;
const auth = () => resolveCLIProxyCodexAuth(model, salt, env);
const row = (index = "idx-a", account = "account-a") => ({ provider: "codex", type: "codex", account_type: "oauth",
  auth_index: index, id_token: { chatgpt_account_id: account, plan_type: "plus" }, disabled: false, unavailable: false });
const quota = (account = "account-a") => ({ account_id: account, plan_type: "plus", rate_limit: {
  primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 10000 },
  secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 20000 },
}, additional_rate_limits: [{ metered_feature: "gpt-5.5", limit_name: "GPT-5.5", rate_limit: {
  primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 10000 },
} }], credits: { has_credits: false }, rate_limit_reset_credits: { available_count: 2 } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const wrapper = (value: unknown = quota(), status = 200) => ({ status_code: status, header: {}, body: JSON.stringify(value) });
function mockFetch(t: TestContext, handler: typeof fetch) { t.mock.method(globalThis, "fetch", handler); }
function setEnv(t: TestContext, values: NodeJS.ProcessEnv = env) {
  const previous = process.env;
  process.env = { ...values };
  t.after(() => { process.env = previous; });
}
function registry() { return { getAvailable: () => [model], getAll: () => [model],
  getProviderAuthStatus: () => ({ configured: true }), getProviderDisplayName: () => "Codex",
  getApiKeyAndHeaders: async () => assert.fail("inference auth must not be read"),
  getProviderAuth: async () => assert.fail("inference provider auth must not be read") }; }

function settings(selectedTargets: Record<string, string> = {}) {
  let state: UsageSettingsState = { kind: "loaded", path: "/unused/pi-usage.json",
    settings: { ...DEFAULT_USAGE_SETTINGS, selectedTargets }, document: { selectedTargets } };
  const runtime: UsageSettingsRuntime = {
    get: () => structuredClone(state), reload: async () => structuredClone(state), flush: async () => undefined,
    update: async (patch) => { state.settings = { ...state.settings, ...patch }; return structuredClone(state); },
    updateSelectedTarget: async (provider, target, _signal, check) => {
      await check?.();
      const selectedTargets = { ...state.settings.selectedTargets, [provider]: target };
      state = { ...state, settings: { ...state.settings, selectedTargets }, document: { selectedTargets } };
      return structuredClone(state);
    },
  };
  return runtime;
}
async function settle() { for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }

test("codex registers distinct CLIProxyAPI provenance and resolves env-only auth without inference credentials", async (t) => {
  setEnv(t);
  assert.ok(adapter.targets);
  assert.equal(adapter.id, "codex");
  assert.notEqual(adapter, adapterForProvider("openai-codex"));
  const { ctx } = createMockContext({ model, modelRegistry: registry() });
  const resolved = await resolveReadOnlyUsageAuth(ctx, adapter, salt, () => assert.fail("OAuth storage must not be read"));
  assert.equal(resolved?.source, "CLIProxyAPI management environment");
  assert.equal(resolved?.usageKind, "cliproxyapi-codex");
  assert.deepEqual(resolved?.headers, { Authorization: "Bearer management-test-key" });
  assert.equal(resolved?.effectiveBaseUrl, "http://proxy.example.test:8317/v0/management");
});

for (const root of ["http://proxy.example.test:8317", "http://proxy.example.test:8317/", "http://proxy.example.test:8317/v0/management", "http://proxy.example.test:8317/v0/management/", "https://proxy.example.test/v0/management", "HTTPS://PROXY.EXAMPLE.TEST:443/"]) {
  test(`CLIProxyAPI normalizes explicitly trusted management URL ${root}`, () => {
    const resolved = resolveCLIProxyCodexAuth(model, salt, { ...env, CLIPROXYAPI_MANAGEMENT_URL: root });
    assert.equal(resolved.effectiveBaseUrl, `${new URL(root).origin}/v0/management`);
  });
}
for (const root of ["ftp://proxy.test", "file:///tmp/proxy", "javascript:alert(1)", "proxy.test", "http://", "https://user:password@proxy.test", "http://@proxy.test", "http://:@proxy.test", "http://proxy.test?", "http://proxy.test?key=secret", "http://proxy.test#", "http://proxy.test/#secret", "http://proxy.test/v1", "http://proxy.test/v1/v0/management", "http://proxy.test/v0/management/auth-files", "http://proxy.test/../v0/management", "http://proxy.test/%76%30/management", "http://proxy.test//v0/management", " http://proxy.test", "http://proxy.test\\v0\\management"]) {
  test(`CLIProxyAPI rejects unintended management URL ${root}`, () => {
    assert.throws(() => resolveCLIProxyCodexAuth(model, salt, { ...env, CLIPROXYAPI_MANAGEMENT_URL: root }), (error: Error) => {
      assert.match(error.message, /CLIPROXYAPI_MANAGEMENT_URL is invalid/);
      assert.ok(!error.message.includes(root));
      return true;
    });
  });
}

test("CLIProxyAPI missing and invalid environment configuration fails with actionable auth feedback", async (t) => {
  for (const value of [{}, { CLIPROXYAPI_MANAGEMENT_URL: env.CLIPROXYAPI_MANAGEMENT_URL }, { CLIPROXYAPI_MANAGEMENT_KEY: env.CLIPROXYAPI_MANAGEMENT_KEY }]) {
    assert.throws(() => resolveCLIProxyCodexAuth(model, salt, value), /Set CLIPROXYAPI_MANAGEMENT_URL.*CLIPROXYAPI_MANAGEMENT_KEY/);
  }
  for (const key of ["bad\nkey", "has space", "x".repeat(4097), "\u00e9"]) {
    assert.throws(() => resolveCLIProxyCodexAuth(model, salt, { ...env, CLIPROXYAPI_MANAGEMENT_KEY: key }), /printable key/);
  }
  setEnv(t, {});
  mockFetch(t, async () => assert.fail("missing configuration must not probe endpoints"));
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: settings() });
  let text = "";
  const { ctx, statuses } = createMockContext({ hasUI: true, mode: "rpc", model, modelRegistry: registry(),
    select: async (title: string) => { text = title; return "Close"; } });
  await mock.commands.get("usage")!.handler("", ctx);
  assert.match(text, /Authentication unavailable.*CLIPROXYAPI_MANAGEMENT_URL/s);
  assert.equal(statuses.get("usage"), "auth unavailable");
});

test("CLIProxyAPI listing filters non-Codex, disabled and API-key accounts but retains quota-unavailable OAuth", async (t) => {
  mockFetch(t, async () => json({ files: [row(), { ...row("idx-b", "account-b"), unavailable: true },
    { ...row(), provider: "claude" }, { ...row(), disabled: true }, { ...row(), account_type: "api_key", account: "do-not-read-key" }] }));
  const targets = await listUsageTargets(adapter, auth(), signal, 1000, guard);
  assert.deepEqual(targets.map((target) => target.id), ["idx-a:account-a", "idx-b:account-b"]);
  assert.ok(!JSON.stringify(targets).includes("do-not-read-key"));
  const unresolved = await resolveUsageTarget(adapter, auth(), undefined, signal, 1000, guard);
  assert.equal(unresolved.kind, "selection-required");
  assert.deepEqual(await resolveUsageTarget(adapter, auth(), "idx-b:account-b", signal, 1000, guard), { kind: "selected", targetId: "idx-b:account-b" });
  assert.equal((await resolveUsageTarget(adapter, auth(), "old:gone", signal, 1000, guard)).kind, "selection-required");
});

test("CLIProxyAPI single account auto-selects without persisting credentials or needing a dialog", async (t) => {
  mockFetch(t, async () => json({ files: [row()] }));
  assert.deepEqual(await resolveUsageTarget(adapter, auth(), undefined, signal, 1000, guard), { kind: "selected", targetId: "idx-a:account-a" });
});

for (const [name, files] of [
  ["missing files", undefined], ["invalid files", {}], ["invalid row", [null]], ["missing OAuth metadata", [{ ...row(), account_type: undefined }]],
  ["conflicting provider metadata", [{ ...row(), type: "openai" }]], ["invalid disabled metadata", [{ ...row(), disabled: "true" }]], ["missing identity", [{ ...row(), id_token: {} }]],
  ["invalid index", [{ ...row(), auth_index: "bad\nindex" }]], ["invalid identity", [row("idx-a", "bad:account")]],
  ["duplicate index", [row(), row("idx-a", "account-b")]], ["duplicate identity", [row(), row("idx-b", "account-a")]],
  ["too many rows", Array.from({ length: 1001 }, () => row())], ["zero subscription accounts", []],
] as const) {
  test(`CLIProxyAPI listing fails closed for ${name}`, async (t) => {
    mockFetch(t, async () => json({ files }));
    await assert.rejects(listUsageTargets(adapter, auth(), signal, 1000, guard));
  });
}

test("CLIProxyAPI quota forwards only the token placeholder and selected account, normalizes all windows and model buckets", async (t) => {
  const requests: { url: string; init?: RequestInit }[] = [];
  mockFetch(t, async (input, init) => {
    requests.push({ url: String(input), init });
    return json(String(input).endsWith("auth-files") ? { files: [row()] } : wrapper());
  });
  let guards = 0;
  const report = await queryProviderUsage(adapter, { ...auth(), headers: { ...auth().headers, "X-Inference-Key": "inference-test-key" } }, signal, 1000, async () => { guards++; }, "idx-a:account-a");
  assert.ok(guards >= 5);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.ok(request.url.startsWith("http://proxy.example.test:8317/v0/management/"));
    assert.equal(request.init?.redirect, "error");
    assert.equal(new Headers(request.init?.headers).get("Authorization"), "Bearer management-test-key");
    assert.equal(new Headers(request.init?.headers).get("X-Inference-Key"), null);
  }
  const body = JSON.parse(requests[1]!.init!.body as string);
  assert.deepEqual(body, { auth_index: "idx-a", method: "GET", url: "https://chatgpt.com/backend-api/wham/usage", header: {
    Authorization: "Bearer $TOKEN$", "Chatgpt-Account-Id": "account-a", "Content-Type": "application/json",
    "User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
  } });
  assert.ok(!(requests[1]!.init!.body as string).includes("management-test-key"));
  assert.equal(report.providerId, "codex");
  assert.equal(report.source, "cliproxyapi-codex");
  assert.equal(report.accountLabel, "Codex account idx-a");
  assert.equal(report.buckets.length, 3);
  assert.match(formatUsageReport(report, "current"), /5h limit:.*75% left/s);
  assert.match(formatUsageReport(report, "current"), /Weekly limit:.*90% left/s);
  assert.match(formatUsageReport(report, "current"), /not a verified current inference account/);
  assert.equal(formatUsageStatusline(report, model, 9_000_000), "codex proxy gpt 5.5 60% ↻ 17m");
  assert.equal(formatUsageStatusline(report, model, 9_000_000, false), "codex proxy gpt 5.5 60% 5h");
  assert.ok(!JSON.stringify(report).includes("management-test-key"));
});

for (const [name, value] of [
  ["upstream 401", wrapper({ error: "Bearer upstream-secret" }, 401)], ["upstream 429", wrapper({}, 429)],
  ["upstream redirect", wrapper({}, 302)], ["upstream 500", wrapper({}, 500)],
  ["missing status", { body: "{}" }], ["string status", { ...wrapper(), status_code: "200" }], ["invalid status", { ...wrapper(), status_code: 999 }],
  ["non-string body", { ...wrapper(), body: {} }], ["malformed JSON body", { ...wrapper(), body: "management-test-key upstream-secret" }],
  ["array body", wrapper([])], ["wrong identity", wrapper(quota("account-b"))], ["missing identity", wrapper({ ...quota(), account_id: undefined })],
  ["empty quota", wrapper({ account_id: "account-a" })], ["malformed quota", wrapper({ ...quota(), rate_limit: "bad" })],
] as const) {
  test(`CLIProxyAPI rejects ${name} without showing upstream credentials`, async (t) => {
    mockFetch(t, async (input) => json(String(input).endsWith("auth-files") ? { files: [row()] } : value));
    await assert.rejects(queryProviderUsage(adapter, auth(), signal, 1000, guard, "idx-a:account-a"), (error: Error) => {
      assert.ok(!/management-test-key|upstream-secret/.test(error.message));
      return true;
    });
  });
}

test("CLIProxyAPI listing and outer wrapper errors redact bodies, malformed JSON fragments and transport exceptions", async (t) => {
  for (const path of ["auth-files", "api-call"]) {
    for (const response of [() => new Response("management-test-key Bearer upstream-secret", { status: 403 }),
      () => new Response('{"bad":"management-test-key", "token": upstream-secret'),
      () => { throw new Error("transport management-test-key"); }]) {
      mockFetch(t, async (input) => String(input).endsWith(path) ? response() : json({ files: [row()] }));
      const pending = path === "auth-files" ? listUsageTargets(adapter, auth(), signal, 1000, guard)
        : queryProviderUsage(adapter, auth(), signal, 1000, guard, "idx-a:account-a");
      await assert.rejects(pending, (error: Error) => { assert.ok(!/management-test-key|upstream-secret/.test(error.message)); return true; });
      t.mock.restoreAll();
    }
  }
});

test("CLIProxyAPI report redacts management credentials in provider-controlled plan and bucket strings", async (t) => {
  mockFetch(t, async (input) => json(String(input).endsWith("auth-files") ? { files: [row()] }
    : wrapper({ ...quota(), plan_type: "management-test-key", additional_rate_limits: [{
      metered_feature: "management-test-key", limit_name: "management-test-key", rate_limit: quota().rate_limit,
    }] })));
  const report = await queryProviderUsage(adapter, auth(), signal, 1000, guard, "idx-a:account-a");
  assert.ok(!JSON.stringify(report).includes("management-test-key"));
});

test("CLIProxyAPI refuses redirected responses and bounds successful listing and wrapper bodies", async (t) => {
  for (const path of ["auth-files", "api-call"]) {
    for (const kind of ["redirect", "oversized"]) {
      mockFetch(t, async (input) => {
        if (!String(input).endsWith(path)) return json({ files: [row()] });
        if (kind === "oversized") return json({ huge: "x".repeat(65536) });
        const response = json({ files: [row()] });
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      });
      await assert.rejects(path === "auth-files" ? listUsageTargets(adapter, auth(), signal, 1000, guard)
        : queryProviderUsage(adapter, auth(), signal, 1000, guard, "idx-a:account-a"), kind === "redirect" ? /redirected/ : /exceeded 65536 bytes/);
      t.mock.restoreAll();
    }
  }
});

test("CLIProxyAPI cancellation and deadlines stop pending listing or quota bodies", async (t) => {
  for (const path of ["auth-files", "api-call"]) {
    for (const cancel of [true, false]) {
      const controller = new AbortController();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      mockFetch(t, async (input) => {
        if (!String(input).endsWith(path)) return json({ files: [row()] });
        started();
        return new Response(new ReadableStream({ start() {} }));
      });
      const pending = path === "auth-files" ? listUsageTargets(adapter, auth(), controller.signal, cancel ? 1000 : 15, guard)
        : queryProviderUsage(adapter, auth(), controller.signal, cancel ? 1000 : 15, guard, "idx-a:account-a");
      await ready;
      if (cancel) controller.abort();
      await assert.rejects(pending, cancel ? { name: "AbortError" } : /Timed out/);
      t.mock.restoreAll();
    }
  }
});

test("CLIProxyAPI selected identity is checked before and after quota reads without choosing another account", async (t) => {
  for (const changeAfter of [0, 1]) {
    let listings = 0;
    let quotaReads = 0;
    mockFetch(t, async (input) => {
      if (String(input).endsWith("auth-files")) {
        listings++;
        return json({ files: [listings > changeAfter ? row("idx-a", "account-b") : row()] });
      }
      quotaReads++;
      return json(wrapper());
    });
    await assert.rejects(queryProviderUsage(adapter, auth(), signal, 1000, guard, "idx-a:account-a"), /selected CLIProxyAPI proxy account changed/);
    assert.equal(quotaReads, changeAfter);
    t.mock.restoreAll();
  }
  mockFetch(t, async () => assert.fail("unsafe target must fail before requests"));
  for (const target of [undefined, "idx-a", "idx-a:bad\r\naccount", "idx-a:account-a:extra"]) {
    await assert.rejects(queryProviderUsage(adapter, auth(), signal, 1000, guard, target), /Select a valid/);
  }
  await assert.rejects(queryProviderUsage(adapter, auth(), signal, 1000, undefined, "idx-a:account-a"), /request-boundary/);
});

test("CLIProxyAPI auth fingerprints detect URL and key changes, including env changes at request boundaries", async (t) => {
  setEnv(t);
  const initial = auth();
  assert.notEqual(initial.fingerprint, resolveCLIProxyCodexAuth(model, salt, { ...env, CLIPROXYAPI_MANAGEMENT_KEY: "rotated" }).fingerprint);
  assert.notEqual(initial.fingerprint, resolveCLIProxyCodexAuth(model, salt, { ...env, CLIPROXYAPI_MANAGEMENT_URL: "https://different.test" }).fingerprint);
  assert.equal(initial.fingerprint, resolveCLIProxyCodexAuth(model, salt, { ...env, CLIPROXYAPI_MANAGEMENT_URL: `${env.CLIPROXYAPI_MANAGEMENT_URL}/v0/management/` }).fingerprint);
  const { ctx } = createMockContext({ model, modelRegistry: registry() });
  const resolved = (await resolveUsageAuth(ctx, adapter, salt))!;
  let quotaReads = 0;
  mockFetch(t, async (input) => {
    if (String(input).endsWith("auth-files")) { process.env.CLIPROXYAPI_MANAGEMENT_KEY = "rotated"; return json({ files: [row()] }); }
    quotaReads++;
    return json(wrapper());
  });
  await assert.rejects(queryProviderUsage(adapter, resolved, signal, 1000, async () => {
    const latest = await resolveUsageAuth(ctx, adapter, salt);
    if (latest?.fingerprint !== resolved.fingerprint) throw Object.assign(new Error("changed"), { name: "AbortError" });
  }, "idx-a:account-a"), { name: "AbortError" });
  assert.equal(quotaReads, 0);
});

test("CLIProxyAPI menu persists only the explicit multi-account target, separates accounts and disables reset and Fast actions", async (t) => {
  setEnv(t);
  const runtime = settings();
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: runtime, credentialReader: () => assert.fail("must not read OAuth credentials") });
  const requestedIndexes: string[] = [];
  mockFetch(t, async (input, init) => {
    if (String(input).endsWith("auth-files")) return json({ files: [row(), row("idx-b", "account-b")] });
    const index = JSON.parse(init!.body as string).auth_index;
    requestedIndexes.push(index);
    return json(wrapper(quota(index === "idx-a" ? "account-a" : "account-b")));
  });
  const titles: string[] = [];
  let targetSelections = 0;
  const actions = ["Select proxy account…", "Change proxy account…", "Close"];
  const { ctx, statuses } = createMockContext({ hasUI: true, mode: "rpc", model, modelRegistry: registry(),
    select: async (title: string, options: readonly string[]) => {
      titles.push(title);
      assert.ok(!options.some((option) => /Fast mode|Redeem usage limit reset/.test(option)));
      if (title.startsWith("Select proxy account for")) return options[targetSelections++];
      return actions.shift() ?? "Close";
    } });
  await mock.commands.get("usage")!.handler("", ctx);
  assert.deepEqual(requestedIndexes, ["idx-a", "idx-b"]);
  assert.equal(runtime.get().settings.selectedTargets.codex, "idx-b:account-b");
  assert.ok(!JSON.stringify(runtime.get()).includes("management-test-key"));
  assert.match(titles.join("\n"), /Selected CLIProxyAPI account/);
  assert.match(statuses.get("usage") ?? "", /^codex proxy/);
  assert.deepEqual(codexFastAvailability(model, true), { kind: "not-codex" });
  assert.equal(rewriteCodexFastPayload({}, model, true), undefined);
  await assert.rejects(resolveCodexResetAuth(ctx), /current model to use OpenAI Codex/);
});

test("CLIProxyAPI cached reports are bound to env and account identities and do not survive a disappeared target", async (t) => {
  setEnv(t);
  const runtime = settings({ codex: "idx-a:account-a" });
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: runtime });
  let files = [row()];
  let quotaReads = 0;
  mockFetch(t, async (input) => {
    if (String(input).endsWith("auth-files")) return json({ files });
    quotaReads++;
    return json(wrapper());
  });
  const { ctx, statuses } = createMockContext({ hasUI: true, mode: "rpc", model, modelRegistry: registry(), select: async () => "Close" });
  const command = mock.commands.get("usage")!;
  await command.handler("", ctx);
  await command.handler("", ctx);
  assert.equal(quotaReads, 1);
  process.env.CLIPROXYAPI_MANAGEMENT_KEY = "rotated-key";
  await command.handler("", ctx);
  assert.equal(quotaReads, 2);
  process.env.CLIPROXYAPI_MANAGEMENT_URL = "https://different.test";
  await command.handler("", ctx);
  assert.equal(quotaReads, 3);
  files = [row("idx-a", "account-b")];
  await command.handler("", ctx);
  assert.equal(quotaReads, 3);
  assert.equal(statuses.get("usage"), "selection required");
});

for (const change of ["env", "target", "session", "model"] as const) {
  test(`CLIProxyAPI in-flight ${change} changes suppress stale quota and cache publication`, async (t) => {
    setEnv(t);
    const runtime = settings({ codex: "idx-a:account-a" });
    const mock = createMockPi();
    usageExtension(mock.pi, { settingsRuntime: runtime });
    let release!: (value: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    mockFetch(t, async (input) => {
      if (String(input).endsWith("auth-files")) return json({ files: [row()] });
      started();
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    const { ctx, statuses } = createMockContext({ model, modelRegistry: registry() });
    mock.events.get("turn_start")![0]!({}, ctx);
    await ready;
    if (change === "env") process.env.CLIPROXYAPI_MANAGEMENT_KEY = "rotated";
    if (change === "target") await runtime.updateSelectedTarget("codex", "idx-b:account-b");
    if (change === "session") mock.events.get("session_shutdown")![0]!({}, ctx);
    if (change === "model") Object.assign(ctx, { model: { ...model, id: "codex-proxy/other" } });
    release(json(wrapper()));
    await settle();
    assert.ok(!statuses.get("usage")?.includes("60%"));
    mock.events.get("session_shutdown")![0]!({}, ctx);
  });
}

test("CLIProxyAPI countdown revalidates env and selected account before republishing a cached snapshot", async (t) => {
  setEnv(t);
  vi.useFakeTimers();
  t.after(() => vi.useRealTimers());
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: settings() });
  let files = [row()];
  let quotaReads = 0;
  mockFetch(t, async (input) => {
    if (String(input).endsWith("auth-files")) return json({ files });
    quotaReads++;
    return json(wrapper({ ...quota(), rate_limit: { primary_window: { used_percent: 25, reset_at: Date.now() / 1000 + 3600 } }, additional_rate_limits: [] }));
  });
  const { ctx, statuses } = createMockContext({ model, modelRegistry: registry() });
  await mock.events.get("session_start")![0]!({}, ctx);
  await settle();
  assert.match(statuses.get("usage") ?? "", /^codex proxy 75% ↻/);
  files = [row("idx-a", "account-b")];
  await vi.advanceTimersByTimeAsync(60000);
  await settle();
  assert.equal(statuses.get("usage"), undefined);
  assert.equal(quotaReads, 1);
  mock.events.get("session_shutdown")![0]!({}, ctx);
});

for (const change of ["env", "identity"] as const) {
  test(`CLIProxyAPI menu render rejects a prior report after ${change} changes`, async (t) => {
    setEnv(t);
    const mock = createMockPi();
    usageExtension(mock.pi, { settingsRuntime: settings() });
    let files = [row()];
    mockFetch(t, async (input) => json(String(input).endsWith("auth-files") ? { files } : wrapper()));
    const titles: string[] = [];
    const { ctx, statuses } = createMockContext({ hasUI: true, mode: "rpc", model,
      modelRegistry: { ...registry(), getProviderAuthStatus: (provider: string) => ({ configured: provider === "codex" }) },
      select: async (title: string) => {
        titles.push(title);
        if (titles.length === 1) {
          if (change === "env") process.env.CLIPROXYAPI_MANAGEMENT_KEY = "rotated";
          else files = [row("idx-a", "account-b")];
          return "View another configured provider…";
        }
        return "Close";
      } });
    await mock.commands.get("usage")!.handler("", ctx);
    assert.match(titles[0]!, /60% left/);
    assert.match(titles[1]!, /management auth or the selected proxy account changed/);
    assert.ok(!titles[1]!.includes("60% left"));
    assert.equal(statuses.get("usage"), undefined);
  });
}

test("CLIProxyAPI configured-provider publication rechecks the account after current-provider asynchronous work", async (t) => {
  setEnv(t);
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: settings() });
  let listings = 0;
  mockFetch(t, async (input) => {
    if (String(input).endsWith("auth-files")) {
      listings++;
      return json({ files: [listings >= 4 ? row("idx-a", "account-b") : row()] });
    }
    return json(wrapper());
  });
  const unsupported = { ...model, provider: "unsupported" };
  const titles: string[] = [];
  const actions = ["View another configured provider…", "Codex", "Close"];
  const { ctx } = createMockContext({ hasUI: true, mode: "rpc", model: unsupported,
    modelRegistry: { ...registry(), getProviderAuthStatus: (provider: string) => ({ configured: provider === "codex" }) },
    select: async (title: string) => { titles.push(title); return actions.shift() ?? "Close"; } });
  await mock.commands.get("usage")!.handler("", ctx);
  assert.match(titles.at(-1)!, /management auth or the selected proxy account changed/);
  assert.ok(!titles.at(-1)!.includes("60% left"));
});

test("CLIProxyAPI invalid or failed fresh quota does not restore a prior cached report", async (t) => {
  setEnv(t);
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: settings() });
  let quotaReads = 0;
  mockFetch(t, async (input) => {
    if (String(input).endsWith("auth-files")) return json({ files: [row()] });
    quotaReads++;
    return json(quotaReads === 1 ? wrapper() : wrapper({}, 401));
  });
  const titles: string[] = [];
  const actions = ["Refresh current usage", "Close", "Close"];
  const { ctx, statuses } = createMockContext({ hasUI: true, mode: "rpc", model, modelRegistry: registry(),
    select: async (title: string) => { titles.push(title); return actions.shift() ?? "Close"; } });
  await mock.commands.get("usage")!.handler("", ctx);
  await mock.commands.get("usage")!.handler("", ctx);
  assert.equal(quotaReads, 2);
  assert.match(titles[0]!, /60% left/);
  assert.match(titles.at(-1)!, /upstream HTTP 401/);
  assert.ok(!titles.at(-1)!.includes("60% left"));
  assert.match(statuses.get("usage")!, /^usage err:/);
});

test("CLIProxyAPI long management keys are redacted before quota labels are truncated", async (t) => {
  const key = "long-management-secret-".repeat(40);
  const resolved = resolveCLIProxyCodexAuth(model, salt, { ...env, CLIPROXYAPI_MANAGEMENT_KEY: key });
  mockFetch(t, async (input) => json(String(input).endsWith("auth-files") ? { files: [row()] } : wrapper({
    ...quota(), plan_type: key, additional_rate_limits: [{ metered_feature: key, limit_name: key, rate_limit: quota().rate_limit }],
  })));
  const report = await queryProviderUsage(adapter, resolved, signal, 1000, guard, "idx-a:account-a");
  assert.ok(!JSON.stringify(report).includes("long-management-secret"));
});

test("CLIProxyAPI revalidation consumes the shared request deadline before any management request", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  mockFetch(t, async () => assert.fail("expired guard must not send a request"));
  await assert.rejects(queryProviderUsage(adapter, auth(), signal, 20, async () => { now += 25; }, "idx-a:account-a"), /Timed out/);
});

test("CLIProxyAPI superseded publication cannot overwrite a newer same-account statusline", async (t) => {
  setEnv(t);
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: settings() });
  let listings = 0;
  let quotaReads = 0;
  let release!: (value: Response) => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { started = resolve; });
  mockFetch(t, async (input) => {
    if (String(input).endsWith("auth-files")) {
      listings++;
      if (listings === 5) { started(); return new Promise<Response>((resolve) => { release = resolve; }); }
      return json({ files: [row()] });
    }
    quotaReads++;
    return json(wrapper({ ...quota(), additional_rate_limits: [], rate_limit: { primary_window: {
      used_percent: quotaReads === 1 ? 25 : 60, limit_window_seconds: 18000,
    } } }));
  });
  const actions = ["Refresh current usage", "Close"];
  const { ctx, statuses } = createMockContext({ hasUI: true, mode: "rpc", model, modelRegistry: registry(),
    select: async () => actions.shift() ?? "Close" });
  await mock.events.get("session_start")![0]!({}, ctx);
  await blocked;
  await mock.commands.get("usage")!.handler("", ctx);
  assert.equal(statuses.get("usage"), "codex proxy 40% 5h");
  release(json({ files: [row()] }));
  await settle();
  assert.equal(statuses.get("usage"), "codex proxy 40% 5h");
  mock.events.get("session_shutdown")![0]!({}, ctx);
});

test("CLIProxyAPI shutdown cancels a pending publication listing body", async (t) => {
  setEnv(t);
  const mock = createMockPi();
  usageExtension(mock.pi, { settingsRuntime: settings() });
  let listings = 0;
  let cancelled = false;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  mockFetch(t, async (input) => {
    if (String(input).endsWith("auth-files")) {
      listings++;
      if (listings === 5) {
        started();
        return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }));
      }
      return json({ files: [row()] });
    }
    return json(wrapper());
  });
  const { ctx, statuses } = createMockContext({ model, modelRegistry: registry() });
  await mock.events.get("session_start")![0]!({}, ctx);
  await ready;
  await settle();
  mock.events.get("session_shutdown")![0]!({}, ctx);
  await settle();
  assert.equal(cancelled, true);
  assert.equal(statuses.get("usage"), undefined);
});
