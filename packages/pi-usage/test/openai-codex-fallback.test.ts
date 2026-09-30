import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLegacyCodexIdentityHash,
  createOpenAICodexIdentityHash,
  OPENAI_CODEX_USAGE_FALLBACK_URL,
  openAICodexUsagePairingMatches,
  resolveOpenAICodexFallback,
} from "../src/openai-codex-fallback.ts";

const openaiAccess = jwt({ iss: "https://auth.openai.com", sub: "openai-subject", client_id: "openai-client" });
const legacyAccess = jwt({
  iss: "https://auth.openai.com",
  sub: "legacy-subject",
  "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
});
const openaiCredential = {
  type: "oauth",
  access: openaiAccess,
  refresh: "openai-refresh",
  expires: 1_900_000_000_000,
  scope: "chatgpt.tokens.use.direct",
};
const codexCredential = {
  type: "oauth",
  access: legacyAccess,
  refresh: "legacy-refresh",
  expires: 1_900_000_000_000,
  accountId: "account-123",
};

function runtimeContext(options: { openaiAccess?: string; codexAccess?: string } = {}) {
  const activeAccess = options.openaiAccess ?? openaiAccess;
  const codexAccessToken = options.codexAccess ?? legacyAccess;
  const modelRegistry = {
    getApiKeyAndHeaders: async (model: { provider: string; baseUrl: string }) => ({
      ok: true as const,
      headers: { Authorization: `Bearer ${model.provider === "openai" ? activeAccess : codexAccessToken}` },
      baseUrl: model.baseUrl,
    }),
    getProviderAuth: async (provider: string) =>
      provider === "openai"
        ? { source: "oauth", auth: { apiKey: activeAccess, baseUrl: "https://openai-proxy.example/v1" } }
        : undefined,
    getProvider: (provider: string) =>
      provider === "openai"
        ? { baseUrl: "https://openai-proxy.example/v1" }
        : { baseUrl: "https://legacy-proxy.example/v1" },
  };
  const model = {
    provider: "openai",
    id: "openai-sub/gpt-6.1-sol",
    name: "OpenAI subscription model",
    api: "openai-responses",
    baseUrl: "https://openai-proxy.example/v1",
  };
  const codexModel = {
    provider: "openai-codex",
    id: "legacy-model",
    name: "Legacy Codex model",
    api: "openai-responses",
    baseUrl: "https://legacy-proxy.example/v1",
  };
  const ctx = { model, modelRegistry };
  const candidateReader = (_ctx: unknown, provider: string) => ({
    ok: true as const,
    candidates:
      provider === "openai"
        ? [{ ...openaiCredential, access: activeAccess }]
        : [{ ...codexCredential, access: codexAccessToken }],
  });
  return { ctx, codexModel, candidateReader };
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

async function resolve(options: { openaiAccess?: string; codexAccess?: string } = {}) {
  const { ctx, codexModel, candidateReader } = runtimeContext(options);
  return resolveOpenAICodexFallback(ctx as never, codexModel as never, {
    candidateReader: candidateReader as never,
  });
}

test("identity hashes remain stable across token refresh and change with account, client, or workspace", () => {
  const openaiIdentity = { issuer: "https://issuer", subject: "subject", clientId: "client" };
  assert.equal(
    createOpenAICodexIdentityHash(openaiIdentity),
    createOpenAICodexIdentityHash({ ...openaiIdentity }),
  );
  assert.notEqual(
    createOpenAICodexIdentityHash(openaiIdentity),
    createOpenAICodexIdentityHash({ ...openaiIdentity, clientId: "other-client" }),
  );
  const legacyIdentity = { issuer: "https://issuer", subject: "subject", accountId: "workspace-a" };
  assert.notEqual(
    createLegacyCodexIdentityHash(legacyIdentity),
    createLegacyCodexIdentityHash({ ...legacyIdentity, accountId: "workspace-b" }),
  );
});

test("resolver matches runtime OAuth credentials and returns fixed legacy request authentication", async () => {
  const result = await resolve();
  assert.equal(result.codexAuth.headers.Authorization, `Bearer ${legacyAccess}`);
  assert.equal(result.codexAuth.headers["chatgpt-account-id"], "account-123");
  assert.deepEqual(Object.keys(result.codexAuth.headers).sort(), ["Authorization", "chatgpt-account-id"]);
  assert.equal(OPENAI_CODEX_USAGE_FALLBACK_URL, "https://chatgpt.com/backend-api/wham/usage");
  assert.match(result.currentCredentialFingerprint, /^[a-f0-9]{64}$/u);
  const pairing = {
    version: 1 as const,
    openaiIdentityHash: result.openaiIdentityHash,
    codexIdentityHash: result.codexIdentityHash,
  };
  assert.equal(openAICodexUsagePairingMatches(pairing, result), true);
  assert.equal(
    openAICodexUsagePairingMatches({ ...pairing, openaiIdentityHash: "0".repeat(64) }, result),
    false,
  );
});

test("refreshing access tokens does not change the identity hashes or composite guard fingerprint", async () => {
  const refreshedOpenai = jwt({ iss: "https://auth.openai.com", sub: "openai-subject", client_id: "openai-client", jti: "new" });
  const refreshedLegacy = jwt({
    iss: "https://auth.openai.com",
    sub: "legacy-subject",
    jti: "new",
    "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
  });
  const before = await resolve();
  const after = await resolve({ openaiAccess: refreshedOpenai, codexAccess: refreshedLegacy });
  assert.equal(after.openaiIdentityHash, before.openaiIdentityHash);
  assert.equal(after.codexIdentityHash, before.codexIdentityHash);
  assert.equal(after.currentCredentialFingerprint, before.currentCredentialFingerprint);
});

test("resolver fails closed for API-key auth, missing scope, mismatched keys, and conflicting candidates", async () => {
  const { ctx, codexModel, candidateReader } = runtimeContext();
  const apiKeyRegistry = {
    ...ctx.modelRegistry,
    getProviderAuth: async () => ({ source: "api_key", auth: { apiKey: "mock-api-key" } }),
  };
  await assert.rejects(
    resolveOpenAICodexFallback({ ...ctx, modelRegistry: apiKeyRegistry } as never, codexModel as never, {
      candidateReader: candidateReader as never,
    }),
    /requires the active OpenAI OAuth/,
  );

  const missingScope = { ...openaiCredential, scope: "openid profile" };
  await assert.rejects(
    resolveWithCandidates([missingScope], [codexCredential]),
    /direct-token scope/,
  );
  await assert.rejects(resolveWithCandidates([openaiCredential], [codexCredential], { openaiAccess: "Bearer mock-api-key" }), /does not match Pi's stored OAuth/);
  await assert.rejects(resolveWithCandidates([openaiCredential], [codexCredential], { codexAccess: "Bearer mock-legacy-token" }), /does not match Pi's stored OAuth/);

  const conflicting = { ...openaiCredential, refresh: "different-refresh" };
  await assert.rejects(resolveWithCandidates([openaiCredential, conflicting], [codexCredential]), /Conflicting OAuth/);
});

test("duplicate identical candidates are accepted and credential errors do not expose tokens", async () => {
  const { ctx, codexModel } = runtimeContext();
  const candidateReader = (_ctx: unknown, provider: string) => ({
    ok: true as const,
    candidates: provider === "openai" ? [openaiCredential, { ...openaiCredential }] : [codexCredential, { ...codexCredential }],
  });
  const accepted = await resolveOpenAICodexFallback(ctx as never, codexModel as never, {
    candidateReader: candidateReader as never,
  });
  assert.equal(accepted.codexAuth.headers["chatgpt-account-id"], "account-123");
  await assert.rejects(
    resolveWithCandidates([openaiCredential], [codexCredential], {
      openaiAccess: jwt({ iss: "https://auth.openai.com", sub: "other-subject", client_id: "openai-client" }),
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message.includes(openaiAccess), false);
      return true;
    },
  );
});

async function resolveWithCandidates(
  openaiCandidates: unknown[],
  codexCandidates: unknown[],
  runtimeOptions: { openaiAccess?: string; codexAccess?: string } = {},
) {
  const { ctx, codexModel } = runtimeContext(runtimeOptions);
  return resolveOpenAICodexFallback(ctx as never, codexModel as never, {
    candidateReader: ((_ctx: unknown, provider: string) => ({
      ok: true as const,
      candidates: provider === "openai" ? openaiCandidates : codexCandidates,
    })) as never,
  });
}

test("fallback resolver permits HTTP inference proxies and selected-model URL overrides", async () => {
  const { ctx, codexModel, candidateReader } = runtimeContext();
  ctx.model.baseUrl = "http://proxy.example/new-model/v1";
  codexModel.baseUrl = "http://proxy.example/legacy-model";
  ctx.modelRegistry.getProvider = () => ({ baseUrl: "http://proxy.example/provider-default" });
  ctx.modelRegistry.getProviderAuth = async () => ({ source: "oauth", auth: {
    apiKey: openaiAccess, baseUrl: "http://proxy.example/provider-default",
  } });
  const result = await resolveOpenAICodexFallback(ctx as never, codexModel as never, { candidateReader: candidateReader as never });
  assert.equal(result.codexAuth.effectiveBaseUrl, "https://chatgpt.com");
});

test("fallback resolver rejects a runtime URL that differs from the selected-model URL", async () => {
  const { ctx, codexModel, candidateReader } = runtimeContext();
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, headers: { Authorization: `Bearer ${openaiAccess}` },
    baseUrl: "https://other-model.example/v1" });
  await assert.rejects(resolveOpenAICodexFallback(ctx as never, codexModel as never, { candidateReader: candidateReader as never }),
    /configured model URL/u);
});

test("fallback resolver rejects conflicting runtime Bearer and API-key values", async () => {
  const { ctx, codexModel, candidateReader } = runtimeContext();
  ctx.modelRegistry.getApiKeyAndHeaders = async (model) => ({ ok: true, apiKey: "different-mock-key",
    headers: { Authorization: `Bearer ${openaiAccess}` }, baseUrl: model.baseUrl });
  await assert.rejects(resolveOpenAICodexFallback(ctx as never, codexModel as never, { candidateReader: candidateReader as never }),
    /conflicting Bearer/u);
});

test("stable fallback cache identity survives refresh but runtime fingerprints detect either token rotation", async () => {
  const before = await resolve();
  const afterOpenai = await resolve({ openaiAccess: jwt({ iss: "https://auth.openai.com", sub: "openai-subject",
    client_id: "openai-client", jti: "rotated" }) });
  assert.equal(before.currentCredentialFingerprint, afterOpenai.currentCredentialFingerprint);
  assert.notEqual(before.openaiAuthFingerprint, afterOpenai.openaiAuthFingerprint);
  assert.equal(before.codexAuth.fingerprint, afterOpenai.codexAuth.fingerprint);
  const afterCodex = await resolve({ codexAccess: jwt({ iss: "https://auth.openai.com", sub: "legacy-subject",
    jti: "rotated", "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } }) });
  assert.equal(before.currentCredentialFingerprint, afterCodex.currentCredentialFingerprint);
  assert.equal(before.openaiAuthFingerprint, afterCodex.openaiAuthFingerprint);
  assert.notEqual(before.codexAuth.fingerprint, afterCodex.codexAuth.fingerprint);
});
