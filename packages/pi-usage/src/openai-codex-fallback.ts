import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codexAccountIdFromAccessToken, validCodexAccountId } from "./codex-account.ts";
import { errorMessage, fingerprintResolvedAuth, redactUsageError } from "./core.ts";
import type { OAuthCredentialCandidateReader } from "./oauth-credential-source.ts";
import { fallbackOAuthCredentialCandidates } from "./oauth-credential-source.ts";
import type { OpenAICodexUsagePairing } from "./settings.ts";
import type { PiModel, ResolvedUsageAuth } from "./types.ts";

const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
export const OPENAI_CODEX_USAGE_FALLBACK_URL = "https://chatgpt.com/backend-api/wham/usage";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type OpenAICodexFallbackCredentialReader = (providerId: string) => unknown;

export interface OpenAICodexFallbackResolution {
  openaiIdentityHash: string;
  codexIdentityHash: string;
  currentCredentialFingerprint: string;
  openaiAuthFingerprint: string;
  codexAuth: ResolvedUsageAuth;
}

export interface OpenAICodexFallbackRuntime {
  getApiKeyAndHeaders(model: PiModel): Promise<RuntimeAuthResult>;
  getProviderAuth(providerId: string): Promise<RuntimeProviderAuth | undefined>;
  getProvider(providerId: string): { baseUrl?: string } | undefined;
}

export type RuntimeAuthResult = ({ ok: true } & RuntimeAuth) | { ok: false; error: string };

export interface RuntimeAuth {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
  env?: Record<string, string>;
}

export interface RuntimeProviderAuth {
  auth: RuntimeAuth;
  source?: string;
}

export function createOpenAICodexIdentityHash(identity: {
  issuer: string;
  subject: string;
  clientId: string;
}): string {
  return hashIdentity("openai-oauth-v1", [identity.issuer, identity.subject, identity.clientId]);
}

export function createLegacyCodexIdentityHash(identity: {
  issuer: string;
  subject: string;
  accountId: string;
}): string {
  return hashIdentity("openai-codex-oauth-v1", [identity.issuer, identity.subject, identity.accountId]);
}

export function createOpenAICodexUsagePairing(
  openaiIdentityHash: string,
  codexIdentityHash: string,
): OpenAICodexUsagePairing {
  if (!SHA256_PATTERN.test(openaiIdentityHash) || !SHA256_PATTERN.test(codexIdentityHash)) {
    throw new Error("Cannot pair invalid OpenAI OAuth identity hashes.");
  }
  return { version: 1, openaiIdentityHash, codexIdentityHash };
}

export function openAICodexUsagePairingMatches(
  pairing: OpenAICodexUsagePairing | undefined,
  resolution: Pick<OpenAICodexFallbackResolution, "openaiIdentityHash" | "codexIdentityHash">,
): boolean {
  return (
    pairing?.version === 1 &&
    pairing.openaiIdentityHash === resolution.openaiIdentityHash &&
    pairing.codexIdentityHash === resolution.codexIdentityHash
  );
}

export function revokeOpenAICodexUsagePairing(): undefined {
  return undefined;
}

type FallbackResolverOptions = {
  salt?: Uint8Array;
  credentialReader?: OpenAICodexFallbackCredentialReader;
  candidateReader?: OAuthCredentialCandidateReader;
};

// unpaired automatic refresh must not resolve or refresh an unrelated legacy credential
export async function resolveActiveOpenAIFallbackIdentity(
  ctx: ExtensionContext,
  options: FallbackResolverOptions = {},
): Promise<{ openaiIdentityHash: string; openaiAuthFingerprint: string; openaiBaseUrl: string }> {
  const model = ctx.model;
  const registry = ctx.modelRegistry as unknown as OpenAICodexFallbackRuntime;
  if (!model || model.provider !== "openai" ||
      typeof registry.getApiKeyAndHeaders !== "function" ||
      typeof registry.getProviderAuth !== "function" || typeof registry.getProvider !== "function") {
    throw new Error("OpenAI Codex fallback requires Pi runtime OpenAI authentication.");
  }
  const source = await registry.getProviderAuth("openai");
  if (source?.source?.toLowerCase() !== "oauth") {
    throw new Error("OpenAI Codex fallback requires the active OpenAI OAuth subscription credential.");
  }
  const runtime = await resolveRuntimeAuth(registry, model, "OpenAI");
  const access = runtimeBearer(runtime);
  if (runtimeBearer(await resolveRuntimeAuthFromValue(source.auth, "OpenAI")) !== access) {
    throw new Error("OpenAI OAuth provider authentication does not match the active model credential.");
  }
  const candidates = options.candidateReader
    ? options.candidateReader(ctx, "openai")
    : fallbackOAuthCredentialCandidates("openai", options.credentialReader ?? (() => undefined));
  if (!candidates.ok) throw new Error("OpenAI OAuth credential discovery failed closed.");
  const match = matchOpenAICredential(candidates.candidates, access);
  const openaiBaseUrl = checkedConfiguredBaseUrl("openai", model,
    registry.getProvider("openai")?.baseUrl, runtime.baseUrl);
  return {
    openaiIdentityHash: createOpenAICodexIdentityHash(match.identity),
    openaiAuthFingerprint: fingerprintResolvedAuth({ headers: runtime.headers, baseUrl: openaiBaseUrl }, options.salt ?? new Uint8Array()),
    openaiBaseUrl,
  };
}

export async function resolveOpenAICodexFallback(
  ctx: ExtensionContext,
  codexModel: PiModel,
  options: FallbackResolverOptions = {},
): Promise<OpenAICodexFallbackResolution> {
  const { openaiIdentityHash, openaiAuthFingerprint, openaiBaseUrl } =
    await resolveActiveOpenAIFallbackIdentity(ctx, options);
  if (codexModel.provider !== "openai-codex") {
    throw new Error("OpenAI Codex fallback requires a configured legacy Codex model.");
  }
  const registry = ctx.modelRegistry as unknown as OpenAICodexFallbackRuntime;
  const salt = options.salt ?? new Uint8Array();
  const codexRuntime = await resolveRuntimeAuth(registry, codexModel, "OpenAI Codex");
  const codexBaseUrl = checkedConfiguredBaseUrl("openai-codex", codexModel,
    registry.getProvider("openai-codex")?.baseUrl, codexRuntime.baseUrl);
  const codexCandidates = options.candidateReader
    ? options.candidateReader(ctx, "openai-codex")
    : fallbackOAuthCredentialCandidates("openai-codex", options.credentialReader ?? (() => undefined));
  if (!codexCandidates.ok) throw new Error("OpenAI OAuth credential discovery failed closed.");
  const codexAccess = runtimeBearer(codexRuntime);
  const codexMatch = matchCodexCredential(codexCandidates.candidates, codexAccess);
  const codexIdentityHash = createLegacyCodexIdentityHash(codexMatch.identity);
  const codexHeaders = {
    Authorization: `Bearer ${codexAccess}`,
    "chatgpt-account-id": codexMatch.identity.accountId,
  };
  const codexAuth: ResolvedUsageAuth = {
    apiKey: codexAccess,
    headers: codexHeaders,
    fingerprint: fingerprintResolvedAuth({ headers: codexHeaders, baseUrl: codexBaseUrl }, salt),
    secrets: [...new Set([codexAccess, codexMatch.refresh, codexMatch.identity.accountId])],
    model: codexModel,
    auth: { apiKey: codexAccess },
    source: "matched legacy OpenAI Codex OAuth credential",
    usageKind: "openai-codex-fallback",
    effectiveBaseUrl: "https://chatgpt.com",
  };
  const currentCredentialFingerprint = hashIdentity("openai-codex-fallback-current-v1", [
    openaiIdentityHash,
    codexIdentityHash,
    openaiBaseUrl,
    codexBaseUrl,
  ]);
  // legacy auth resolution can refresh or replace the active connection while awaiting runtime auth
  const activeAfterLegacy = await resolveActiveOpenAIFallbackIdentity(ctx, options);
  if (activeAfterLegacy.openaiAuthFingerprint !== openaiAuthFingerprint ||
      activeAfterLegacy.openaiIdentityHash !== openaiIdentityHash || activeAfterLegacy.openaiBaseUrl !== openaiBaseUrl) {
    throw new Error("OpenAI authentication changed while resolving legacy Codex authentication.");
  }
  return { openaiIdentityHash, codexIdentityHash, currentCredentialFingerprint, openaiAuthFingerprint, codexAuth };
}

export function isSafeOpenAICodexFallbackIdentityHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

async function resolveRuntimeAuth(
  registry: OpenAICodexFallbackRuntime,
  model: PiModel,
  providerName: string,
): Promise<RuntimeAuth> {
  let result: RuntimeAuthResult;
  try {
    result = await registry.getApiKeyAndHeaders(model);
  } catch (error) {
    throw new Error(redactUsageError(errorMessage(error)));
  }
  if (!result.ok) throw new Error(redactUsageError(result.error));
  if (result.env && Object.keys(result.env).length > 0) {
    throw new Error(`${providerName} fallback authentication cannot use provider environment credentials.`);
  }
  const authorization = headerValue(result.headers, "authorization");
  const headerAccess = bearerToken(authorization);
  const keyAccess = bearerToken(result.apiKey ? `Bearer ${result.apiKey}` : undefined);
  if (authorization && !headerAccess || headerAccess && keyAccess && headerAccess !== keyAccess) {
    throw new Error(`${providerName} runtime authentication has conflicting Bearer credentials.`);
  }
  const access = headerAccess ?? keyAccess;
  if (!access) throw new Error(`${providerName} runtime authentication was not a Bearer token.`);
  return { ...result, apiKey: access, headers: { Authorization: `Bearer ${access}` } };
}

async function resolveRuntimeAuthFromValue(auth: RuntimeAuth, providerName: string): Promise<RuntimeAuth> {
  if (auth.env && Object.keys(auth.env).length > 0) {
    throw new Error(`${providerName} fallback authentication cannot use provider environment credentials.`);
  }
  const authorization = headerValue(auth.headers, "authorization");
  const access = bearerToken(authorization) ?? bearerToken(auth.apiKey ? `Bearer ${auth.apiKey}` : undefined);
  if (!access) throw new Error(`${providerName} provider authentication was not a Bearer token.`);
  return { ...auth, apiKey: access, headers: { Authorization: `Bearer ${access}` } };
}

function checkedConfiguredBaseUrl(
  providerId: string,
  model: PiModel,
  ...configured: Array<string | undefined>
): string {
  const [providerBaseUrl, runtimeBaseUrl] = configured;
  const selected = model.baseUrl || providerBaseUrl;
  if (!selected) throw new Error(`${providerId} configured model URL is unavailable.`);
  const normalize = (value: string) => {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
        throw new Error("unsafe URL");
      }
      return url.toString();
    } catch {
      throw new Error(`${providerId} configured model URL is invalid.`);
    }
  };
  const selectedUrl = normalize(selected);
  if (runtimeBaseUrl && normalize(runtimeBaseUrl) !== selectedUrl) {
    throw new Error(`${providerId} runtime authentication does not match its configured model URL.`);
  }
  return selectedUrl;
}

function matchOpenAICredential(candidates: readonly unknown[], access: string): {
  refresh: string;
  identity: { issuer: string; subject: string; clientId: string };
} {
  let sawOAuth = false;
  let sawMatchingAccess = false;
  let sawInvalidMatch = false;
  const matches = new Map<string, { refresh: string; identity: { issuer: string; subject: string; clientId: string } }>();
  for (const candidate of candidates) {
    const credential = asRecord(candidate);
    if (credential?.type !== "oauth") continue;
    sawOAuth = true;
    if (credential.access !== access) continue;
    sawMatchingAccess = true;
    const claims = jwtClaims(access);
    const issuer = safeIdentityPart(claims?.iss);
    const subject = safeIdentityPart(claims?.sub);
    const clientId = safeIdentityPart(claims?.client_id ?? claims?.clientId);
    const scope = stringList(credential.scope ?? credential.scopes ?? claims?.scope);
    const refresh = nonempty(credential.refresh);
    if (
      !issuer ||
      !subject ||
      !clientId ||
      !refresh ||
      typeof credential.expires !== "number" ||
      !Number.isFinite(credential.expires) ||
      !scope.includes(DIRECT_TOKEN_SCOPE)
    ) {
      sawInvalidMatch = true;
      continue;
    }
    const identity = { issuer, subject, clientId };
    matches.set(JSON.stringify([issuer, subject, clientId, refresh]), { identity, refresh });
  }
  if (sawInvalidMatch) throw new Error("The matching OpenAI OAuth credential lacks safe identity claims or direct-token scope.");
  if (matches.size > 1) throw new Error("Conflicting OAuth credentials match the active OpenAI runtime account.");
  const match = matches.values().next().value;
  if (!match) {
    if (!sawOAuth) throw new Error("OpenAI Codex fallback requires an OAuth account configured through Pi /login.");
    if (sawMatchingAccess) throw new Error("The matching OpenAI OAuth credential was incomplete.");
    throw new Error("The active OpenAI runtime account does not match Pi's stored OAuth account.");
  }
  return match;
}

function matchCodexCredential(candidates: readonly unknown[], access: string): {
  refresh: string;
  identity: { issuer: string; subject: string; accountId: string };
} {
  let sawOAuth = false;
  let sawMatchingAccess = false;
  let sawInvalidMatch = false;
  const matches = new Map<string, { refresh: string; identity: { issuer: string; subject: string; accountId: string } }>();
  const tokenAccountId = codexAccountIdFromAccessToken(access);
  for (const candidate of candidates) {
    const credential = asRecord(candidate);
    if (credential?.type !== "oauth") continue;
    sawOAuth = true;
    if (credential.access !== access) continue;
    sawMatchingAccess = true;
    const claims = jwtClaims(access);
    const issuer = safeIdentityPart(claims?.iss);
    const subject = safeIdentityPart(claims?.sub);
    const accountId = validCodexAccountId(credential.accountId);
    const refresh = nonempty(credential.refresh);
    if (
      !issuer ||
      !subject ||
      !accountId ||
      accountId !== tokenAccountId ||
      !refresh ||
      typeof credential.expires !== "number" ||
      !Number.isFinite(credential.expires)
    ) {
      sawInvalidMatch = true;
      continue;
    }
    const identity = { issuer, subject, accountId };
    matches.set(JSON.stringify([issuer, subject, accountId, refresh]), { identity, refresh });
  }
  if (sawInvalidMatch) throw new Error("The matching OpenAI Codex OAuth credential was incomplete or had an invalid account ID.");
  if (matches.size > 1) throw new Error("Conflicting OAuth credentials match the active OpenAI Codex account.");
  const match = matches.values().next().value;
  if (!match) {
    if (!sawOAuth) throw new Error("OpenAI Codex fallback requires a legacy OAuth account configured through Pi /login.");
    if (sawMatchingAccess) throw new Error("The matching OpenAI Codex OAuth credential was incomplete.");
    throw new Error("The active OpenAI Codex account does not match Pi's stored OAuth account.");
  }
  return match;
}

function hashIdentity(namespace: string, fields: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([namespace, ...fields]), "utf8").digest("hex");
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  try {
    const pieces = token.split(".");
    if (pieces.length !== 3) return undefined;
    const value: unknown = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function safeIdentityPart(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  if (!/^[\x21-\x7e]+$/u.test(value)) return undefined;
  return value;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[\s,]+/u).filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return [];
}

function runtimeBearer(auth: RuntimeAuth): string {
  const access = bearerToken(headerValue(auth.headers, "authorization"));
  if (!access) throw new Error("OpenAI OAuth runtime authentication was incomplete.");
  return access;
}

function bearerToken(value: string | undefined): string | undefined {
  return /^Bearer\s+(.+)$/iu.exec(value ?? "")?.[1];
}

function headerValue(headers: Record<string, string | null> | undefined, name: string): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1] ?? undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
