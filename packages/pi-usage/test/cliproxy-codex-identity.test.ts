import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { adapterForProvider, queryProviderUsage } from "../src/query.ts";
import { resolveCLIProxyCodexAuth } from "../src/providers/cliproxy-codex.ts";
import { listUsageTargets, resolveUsageTarget } from "../src/usage-targets.ts";
import type { PiModel } from "../src/types.ts";
import { createMockContext, createMockPi } from "./support.ts";
import { DEFAULT_USAGE_SETTINGS, type UsageSettingsRuntime, type UsageSettingsState } from "../src/settings.ts";
import usageExtension from "../src/usage.ts";

const model = { provider: "codex", id: "codex-proxy/test", name: "Test" } as PiModel;
const adapter = adapterForProvider("codex")!;
const auth = () => resolveCLIProxyCodexAuth(model, new Uint8Array([1]), {
  CLIPROXYAPI_MANAGEMENT_URL: "https://proxy.example.test",
  CLIPROXYAPI_MANAGEMENT_KEY: "management-test-key",
});
const signal = new AbortController().signal;
const guard = async () => undefined;
const row = (index = "idx-a", id = "credential-a") => ({
  provider: "codex", type: "codex", account_type: "oauth", disabled: false,
  auth_index: index, id,
});
const quota = (user = "user-a", account = "") => ({
  user_id: user, account_id: account, plan_type: "plus",
  rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } },
});
const json = (value: unknown) => new Response(JSON.stringify(value));
const wrapped = (body: unknown, status = 200) => json({ status_code: status, body: JSON.stringify(body) });
function mock(t: TestContext, handler: typeof fetch) { t.mock.method(globalThis, "fetch", handler); }

function settings(): UsageSettingsRuntime {
  const state: UsageSettingsState = { kind: "loaded", path: "/unused/pi-usage.json", document: {},
    settings: { ...DEFAULT_USAGE_SETTINGS, selectedTargets: {} } };
  return { get: () => structuredClone(state), reload: async () => structuredClone(state), flush: async () => undefined,
    update: async () => structuredClone(state), updateSelectedTarget: async () => structuredClone(state) };
}

test("CLIProxyAPI discovers missing ID-token metadata using upstream user identity and empty account scope", async (t) => {
  const requests: RequestInit[] = [];
  mock(t, async (input, init) => {
    requests.push(init!);
    return String(input).endsWith("auth-files") ? json({ files: [row()] }) : wrapped(quota());
  });
  const targets = await listUsageTargets(adapter, auth(), signal, 1000, guard);
  assert.equal(targets.length, 1);
  assert.match(targets[0]!.id, /^idx-a:quota:v1:[a-f0-9]{64}$/u);
  assert.ok(!JSON.stringify(targets).includes("user-a"));
  assert.ok(!JSON.stringify(targets).includes("credential-a"));
  const report = await queryProviderUsage(adapter, auth(), signal, 1000, guard, targets[0]!.id);
  assert.equal(report.buckets[0]!.remaining, 75);
  assert.ok(report.notes?.some((note) => /token-default quota scope/iu.test(note)));
  for (const init of requests.filter((request) => request.method === "POST")) {
    const forwarded = JSON.parse(init.body as string);
    assert.equal(forwarded.auth_index, "idx-a");
    assert.equal(forwarded.url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(forwarded.header.Authorization, "Bearer $TOKEN$");
    assert.equal(forwarded.header["Chatgpt-Account-Id"], undefined);
    assert.ok(!(init.body as string).includes("management-test-key"));
    assert.equal(init.redirect, "error");
  }
});

test("CLIProxyAPI scopes subsequent quota reads to a discovered nonempty account", async (t) => {
  const headers: Record<string, string>[] = [];
  mock(t, async (input, init) => {
    if (String(input).endsWith("auth-files")) return json({ files: [row()] });
    headers.push(JSON.parse(init!.body as string).header);
    return wrapped(quota("user-a", "account-a"));
  });
  const target = (await listUsageTargets(adapter, auth(), signal, 1000, guard))[0]!;
  await queryProviderUsage(adapter, auth(), signal, 1000, guard, target.id);
  assert.ok(headers.some((value) => value["Chatgpt-Account-Id"] === "account-a"));
});

for (const change of ["user", "scope", "credential"] as const) {
  test(`CLIProxyAPI quota-identity targets change when ${change} changes`, async (t) => {
    let user = "user-a", account = "", credential = "credential-a";
    mock(t, async (input) => String(input).endsWith("auth-files") ? json({ files: [row("idx-a", credential)] }) : wrapped(quota(user, account)));
    const before = (await listUsageTargets(adapter, auth(), signal, 1000, guard))[0]!.id;
    if (change === "user") user = "user-b";
    if (change === "scope") account = "account-b";
    if (change === "credential") credential = "credential-b";
    const after = (await listUsageTargets(adapter, auth(), signal, 1000, guard))[0]!.id;
    assert.notEqual(before, after);
    assert.equal((await resolveUsageTarget(adapter, auth(), before, signal, 1000, guard)).kind, "selection-required");
    await assert.rejects(queryProviderUsage(adapter, auth(), signal, 1000, guard, before), /changed/);
  });
}

for (const change of ["user", "scope"] as const) {
  test(`CLIProxyAPI rejects in-flight ${change} changes in metadata-free quota responses`, async (t) => {
    let reads = 0;
    mock(t, async (input) => {
      if (String(input).endsWith("auth-files")) return json({ files: [row()] });
      reads++;
      return wrapped(reads === 3 ? quota(change === "user" ? "user-b" : "user-a", change === "scope" ? "account-b" : "") : quota());
    });
    const target = (await listUsageTargets(adapter, auth(), signal, 1000, guard))[0]!;
    await assert.rejects(queryProviderUsage(adapter, auth(), signal, 1000, guard, target.id), /match/);
  });
}

test("CLIProxyAPI rechecks quota identity after the verified read before returning a report", async (t) => {
  let reads = 0;
  mock(t, async (input) => {
    if (String(input).endsWith("auth-files")) return json({ files: [row()] });
    return wrapped(quota(++reads === 4 ? "user-b" : "user-a"));
  });
  const target = (await listUsageTargets(adapter, auth(), signal, 1000, guard))[0]!;
  await assert.rejects(queryProviderUsage(adapter, auth(), signal, 1000, guard, target.id), /changed/);
});

for (const [name, payload] of [
  ["empty user", quota("")], ["missing user", { ...quota(), user_id: undefined }],
  ["invalid user", quota("bad\nuser")], ["long user", quota("x".repeat(513))],
  ["whitespace user", quota(" ")], ["padded scope", quota("user-a", " account-a")],
  ["missing scope", { ...quota(), account_id: undefined }], ["null scope", { ...quota(), account_id: null }],
  ["invalid scope", quota("user-a", "bad\naccount")],
] as const) {
  test(`CLIProxyAPI rejects ${name} during identity discovery`, async (t) => {
    mock(t, async (input) => String(input).endsWith("auth-files") ? json({ files: [row()] }) : wrapped(payload));
    await assert.rejects(listUsageTargets(adapter, auth(), signal, 1000, guard));
  });
}

test("CLIProxyAPI missing credential ID fails before any identity request", async (t) => {
  mock(t, async (input) => {
    assert.ok(String(input).endsWith("auth-files"));
    return json({ files: [{ ...row(), id: undefined }] });
  });
  await assert.rejects(listUsageTargets(adapter, auth(), signal, 1000, guard));
});

test("CLIProxyAPI duplicate upstream identities cannot become separate selectable targets", async (t) => {
  mock(t, async (input) => String(input).endsWith("auth-files") ? json({ files: [row(), row("idx-b", "credential-b")] }) : wrapped(quota()));
  await assert.rejects(listUsageTargets(adapter, auth(), signal, 1000, guard), /ambiguous/);
});

test("CLIProxyAPI metadata-free multiple accounts remain distinct and require explicit selection", async (t) => {
  mock(t, async (input, init) => String(input).endsWith("auth-files")
    ? json({ files: [row(), row("idx-b", "credential-b")] })
    : wrapped(quota(JSON.parse(init!.body as string).auth_index === "idx-a" ? "user-a" : "user-b")));
  const resolution = await resolveUsageTarget(adapter, auth(), undefined, signal, 1000, guard);
  assert.equal(resolution.kind, "selection-required");
  if (resolution.kind === "selection-required") assert.equal(resolution.choices.length, 2);
});

test("CLIProxyAPI does not fall back when supplied ID-token identity is malformed", async (t) => {
  mock(t, async (input) => {
    assert.ok(String(input).endsWith("auth-files"));
    return json({ files: [{ ...row(), id_token: {} }] });
  });
  await assert.rejects(listUsageTargets(adapter, auth(), signal, 1000, guard));
});

test("CLIProxyAPI identity discovery validates upstream status without exposing response data", async (t) => {
  mock(t, async (input) => String(input).endsWith("auth-files") ? json({ files: [row()] })
    : wrapped({ error: "management-test-key upstream-secret" }, 401));
  await assert.rejects(listUsageTargets(adapter, auth(), signal, 1000, guard), (error: Error) => {
    assert.match(error.message, /upstream HTTP 401/);
    assert.ok(!/management-test-key|upstream-secret/u.test(error.message));
    return true;
  });
});

test("CLIProxyAPI aborts identity discovery when configuration guard changes", async (t) => {
  mock(t, async (input) => String(input).endsWith("auth-files") ? json({ files: [row()] }) : wrapped(quota()));
  let checks = 0;
  await assert.rejects(listUsageTargets(adapter, auth(), signal, 1000, async () => {
    if (++checks === 4) throw new Error("configuration changed");
  }), /configuration changed/);
});

test("CLIProxyAPI cancellation closes a pending identity-discovery response body", async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  mock(t, async (input) => {
    if (String(input).endsWith("auth-files")) return json({ files: [row()] });
    return new Response(new ReadableStream({ start() { setImmediate(() => controller.abort()); },
      cancel() { cancelled = true; } }));
  });
  await assert.rejects(listUsageTargets(adapter, auth(), controller.signal, 1000, guard), { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("CLIProxyAPI identity discovery checks the shared deadline before each quota request", async (t) => {
  let now = 1000, checks = 0;
  t.mock.method(Date, "now", () => now);
  mock(t, async (input) => {
    assert.ok(String(input).endsWith("auth-files"));
    return json({ files: [row()] });
  });
  await assert.rejects(listUsageTargets(adapter, auth(), signal, 20, async () => {
    if (++checks === 3) now += 25;
  }), /Timed out/);
});

test("CLIProxyAPI metadata-free discovery bounds and sanitizes quota wrappers", async (t) => {
  for (const body of ["management-test-key upstream-secret", "[1]", JSON.stringify({ huge: "x".repeat(65536) })]) {
    mock(t, async (input) => String(input).endsWith("auth-files") ? json({ files: [row()] })
      : json({ status_code: 200, body }));
    await assert.rejects(listUsageTargets(adapter, auth(), signal, 1000, guard), (error: Error) => {
      assert.ok(!/management-test-key|upstream-secret/u.test(error.message));
      return true;
    });
    t.mock.restoreAll();
  }
});

for (const stage of ["cache", "publication"] as const) {
  test(`CLIProxyAPI metadata-free ${stage} checks suppress reports after upstream user changes`, async (t) => {
    const previousEnv = process.env;
    process.env = { CLIPROXYAPI_MANAGEMENT_URL: "https://proxy.example.test", CLIPROXYAPI_MANAGEMENT_KEY: "management-test-key" };
    t.after(() => { process.env = previousEnv; });
    const mockPi = createMockPi();
    usageExtension(mockPi.pi, { settingsRuntime: settings() });
    let user = "user-a", reads = 0;
    mock(t, async (input) => {
      if (String(input).endsWith("auth-files")) return json({ files: [row()] });
      reads++;
      if (stage === "publication" && reads === 5) user = "user-b";
      const payload = quota(user);
      payload.rate_limit.primary_window.used_percent = user === "user-a" ? 25 : 60;
      return wrapped(payload);
    });
    const titles: string[] = [];
    const { ctx, statuses } = createMockContext({ hasUI: true, mode: "rpc", model,
      modelRegistry: { getAvailable: () => [model], getAll: () => [model], getProviderDisplayName: () => "Codex",
        getProviderAuthStatus: () => ({ configured: true }) },
      select: async (title: string) => { titles.push(title); return "Close"; } });
    const command = mockPi.commands.get("usage")!;
    await command.handler("", ctx);
    if (stage === "cache") {
      assert.match(titles[0]!, /75% left/);
      user = "user-b";
      await command.handler("", ctx);
      assert.match(titles.at(-1)!, /40% left/);
      assert.ok(reads > 5);
    } else {
      assert.ok(!titles.some((title) => /75% left/u.test(title)));
      assert.ok(!statuses.get("usage")?.includes("75%"));
    }
  });
}
