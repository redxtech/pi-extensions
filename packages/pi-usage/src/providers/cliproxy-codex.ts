import { createHash } from "node:crypto";
import { validCodexAccountId } from "../codex-account.ts";
import { errorMessage, fingerprintResolvedAuth, redactUsageError } from "../core.ts";
import type { PiModel, ResolvedUsageAuth, UsageProviderAdapter, UsageProviderTarget, UsageRequestGuard } from "../types.ts";
import { normalizeCodexBackendPayload } from "./codex.ts";
import type { fetchProviderJson } from "../query.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLI_USER_AGENT = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal";
const CONFIG_HINT = "Set CLIPROXYAPI_MANAGEMENT_URL to a trusted HTTP(S) origin or /v0/management root and CLIPROXYAPI_MANAGEMENT_KEY to its management key.";

export function resolveCLIProxyCodexAuth(
  model: PiModel,
  salt: Uint8Array,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedUsageAuth {
  const rawUrl = env.CLIPROXYAPI_MANAGEMENT_URL;
  const key = env.CLIPROXYAPI_MANAGEMENT_KEY;
  if (!rawUrl || !key) throw new Error(`CLIProxyAPI management auth is unavailable. ${CONFIG_HINT}`);
  if (!/^[\x21-\x7e]{1,4096}$/u.test(key)) {
    throw new Error("CLIPROXYAPI_MANAGEMENT_KEY must be a nonempty printable key without spaces or control characters.");
  }
  const root = managementRoot(rawUrl);
  const headers = { Authorization: `Bearer ${key}` };
  return {
    usageKind: "cliproxyapi-codex",
    headers,
    effectiveBaseUrl: root,
    source: "CLIProxyAPI management environment",
    model,
    fingerprint: fingerprintResolvedAuth({ headers, baseUrl: root, source: "CLIProxyAPI" }, salt),
    secrets: [key, headers.Authorization],
  };
}

function managementRoot(value: string): string {
  const invalid = () => new Error(`CLIPROXYAPI_MANAGEMENT_URL is invalid. ${CONFIG_HINT} URL credentials, query, fragment, and other paths are not allowed.`);
  if (value.length > 2048 || /[\s\\?#]/u.test(value)) throw invalid();
  // validate the original path too: URL parsing must not authorize dot-segment aliases
  const parts = /^(https?):\/\/([^/]+)(\/.*)?$/iu.exec(value);
  if (!parts || parts[2]!.includes("@") || ![undefined, "/", "/v0/management", "/v0/management/"].includes(parts[3])) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!url.hostname || url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw invalid();
  return `${url.origin}/v0/management`;
}

type ProxyCredential = { authIndex: string; accountId?: string; credentialId?: string };
type ProxyAccount = ProxyCredential & { accountId: string; userId?: string; target: UsageProviderTarget };

function proxyCredentials(payload: Record<string, unknown>): ProxyCredential[] {
  if (!Array.isArray(payload.files) || payload.files.length > 1000) {
    throw new Error("CLIProxyAPI account listing must contain a bounded files array.");
  }
  const indexes = new Set<string>();
  const result: ProxyCredential[] = [];
  for (const raw of payload.files) {
    const row = object(raw);
    if (!row) throw new Error("CLIProxyAPI account listing contains an invalid row.");
    if (row.provider !== "codex") continue;
    if (row.disabled !== undefined && typeof row.disabled !== "boolean") {
      throw new Error("CLIProxyAPI Codex account has invalid disabled metadata.");
    }
    if (row.disabled === true) continue;
    if (row.type !== undefined && row.type !== "codex") throw new Error("CLIProxyAPI Codex provider metadata is ambiguous.");
    if (row.account_type === "api_key") continue;
    if (row.account_type !== "oauth") throw new Error("CLIProxyAPI Codex account lacks OAuth identity metadata.");
    const authIndex = row.auth_index;
    if (typeof authIndex !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(authIndex)) {
      throw new Error("CLIProxyAPI Codex account has an invalid auth_index.");
    }
    if (indexes.has(authIndex)) throw new Error("CLIProxyAPI Codex account identity is ambiguous.");
    indexes.add(authIndex);
    if (row.id_token !== undefined) {
      const accountId = validCodexAccountId(object(row.id_token)?.chatgpt_account_id);
      if (!accountId || !/^[A-Za-z0-9._-]{1,128}$/u.test(accountId)) {
        throw new Error("CLIProxyAPI Codex account has an invalid ChatGPT account ID.");
      }
      result.push({ authIndex, accountId });
      continue;
    }
    const credentialId = validCodexAccountId(row.id);
    if (!credentialId || credentialId.trim() !== credentialId) throw new Error("CLIProxyAPI Codex account lacks a valid credential ID.");
    result.push({ authIndex, credentialId });
  }
  return result;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function createCLIProxyCodexAdapter(fetchJson: typeof fetchProviderJson): UsageProviderAdapter {
  const managementAuth = (auth: ResolvedUsageAuth): ResolvedUsageAuth => ({
    ...auth, headers: { Authorization: auth.headers.Authorization },
  });
  const fetchQuota = async (auth: ResolvedUsageAuth, authIndex: string, accountId: string | undefined, signal: AbortSignal, timeoutMs: number) => {
    const wrapper = await fetchJson(`${auth.effectiveBaseUrl}/api-call`, managementAuth(auth), signal, timeoutMs,
      "CLIProxyAPI quota request", {
        method: "POST", redirect: "error", userAgent: false,
        responseError: (status) => status < 200 || status >= 300 ? `CLIProxyAPI quota request returned HTTP ${status}. Check management access and account authentication.` : undefined,
        body: { auth_index: authIndex, method: "GET", url: USAGE_URL, header: {
          Authorization: "Bearer $TOKEN$",
          ...(accountId ? { "Chatgpt-Account-Id": accountId } : {}),
          "Content-Type": "application/json", "User-Agent": CLI_USER_AGENT,
        } },
      });
    if (!Number.isInteger(wrapper.status_code) || (wrapper.status_code as number) < 100 || (wrapper.status_code as number) > 599) {
      throw new Error("CLIProxyAPI quota response has an invalid upstream status_code.");
    }
    if ((wrapper.status_code as number) < 200 || (wrapper.status_code as number) >= 300) {
      throw new Error(`CLIProxyAPI ChatGPT quota read returned upstream HTTP ${wrapper.status_code}. Check the selected account subscription authentication.`);
    }
    if (typeof wrapper.body !== "string" || Buffer.byteLength(wrapper.body) > 64 * 1024) {
      throw new Error("CLIProxyAPI quota response has an invalid or oversized body.");
    }
    let payload: Record<string, unknown> | undefined;
    try { payload = object(JSON.parse(wrapper.body)); } catch { /* do not echo upstream body fragments */ }
    if (!payload) throw new Error("CLIProxyAPI quota response body is not a JSON object.");
    return payload;
  };
  const list = async (auth: ResolvedUsageAuth, signal: AbortSignal, timeoutMs: number, guard: UsageRequestGuard) => {
    if (auth.usageKind !== "cliproxyapi-codex" || !auth.effectiveBaseUrl) {
      throw new Error("CLIProxyAPI management auth is unavailable.");
    }
    try {
      const startedAt = Date.now();
      const credentials = proxyCredentials(await fetchJson(`${auth.effectiveBaseUrl}/auth-files`, managementAuth(auth), signal, timeoutMs,
        "CLIProxyAPI account listing", { redirect: "error", userAgent: false,
          responseError: (status) => status < 200 || status >= 300 ? `CLIProxyAPI account listing returned HTTP ${status}. Check the management URL, key, and remote-management access.` : undefined,
        }));
      const accounts: ProxyAccount[] = [];
      const accountIds = new Set<string>();
      const identities = new Set<string>();
      for (const credential of credentials) {
        let accountId = credential.accountId;
        let userId: string | undefined;
        let targetId = `${credential.authIndex}:${accountId}`;
        if (accountId === undefined) {
          // the authenticated usage endpoint identifies the token's default scope without exposing OAuth tokens
          await guard();
          const payload = await fetchQuota(auth, credential.authIndex, undefined, signal, remaining(timeoutMs, startedAt));
          await guard();
          remaining(timeoutMs, startedAt);
          ({ accountId, userId } = quotaIdentity(payload));
          const identity = JSON.stringify([userId, accountId]);
          if (identities.has(identity)) throw new Error("CLIProxyAPI Codex account identity is ambiguous.");
          identities.add(identity);
          const digest = createHash("sha256").update(JSON.stringify([credential.credentialId, userId, accountId])).digest("hex");
          targetId = `${credential.authIndex}:quota:v1:${digest}`;
        }
        if (accountId && accountIds.has(accountId)) throw new Error("CLIProxyAPI Codex account identity is ambiguous.");
        if (accountId) accountIds.add(accountId);
        accounts.push({ ...credential, accountId, ...(userId ? { userId } : {}), target: {
          id: targetId, label: `Codex account ${credential.authIndex}`,
          description: "Selected proxy account, not verified inference identity",
        } });
      }
      if (accounts.some((account) => auth.secrets.some((secret) => account.target.id.includes(secret)))) {
        throw new Error("CLIProxyAPI account identity overlaps a management credential.");
      }
      return accounts;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new Error(redactUsageError(errorMessage(error), auth.secrets));
    }
  };
  return {
    id: "codex",
    displayName: "Codex (CLIProxyAPI)",
    invalidateCacheOnFailure: true,
    semantics: { kind: "consumer-subscription", label: "Selected CLIProxyAPI account subscription limits" },
    targets: {
      singularLabel: "proxy account",
      pluralLabel: "proxy accounts",
      async list(auth, signal, timeoutMs, guard) {
        const startedAt = Date.now();
        await guard();
        const accounts = await list(auth, signal, remaining(timeoutMs, startedAt), guard);
        await guard();
        remaining(timeoutMs, startedAt);
        return accounts.map((account) => account.target);
      },
    },
    async query(auth, signal, timeoutMs, guard, targetId) {
      if (!guard) throw new Error("CLIProxyAPI usage requires request-boundary revalidation.");
      if (!targetId || !/^[A-Za-z0-9_-]{1,64}:(?:[A-Za-z0-9._-]{1,128}|quota:v1:[a-f0-9]{64})$/u.test(targetId)) {
        throw new Error("Select a valid CLIProxyAPI proxy account through /usage.");
      }
      const startedAt = Date.now();
      const selected = async () => {
        await guard();
        const accounts = await list(auth, signal, remaining(timeoutMs, startedAt), guard);
        await guard();
        const account = accounts.find((candidate) => candidate.target.id === targetId);
        if (!account) throw new Error("The selected CLIProxyAPI proxy account changed. Select it again through /usage.");
        return account;
      };
      const account = await selected();
      const payload = await fetchQuota(auth, account.authIndex, account.accountId, signal, remaining(timeoutMs, startedAt));
      await guard();
      if (payload.account_id !== account.accountId || (account.userId !== undefined && quotaIdentity(payload).userId !== account.userId)) {
        throw new Error("CLIProxyAPI quota response does not match the selected proxy account.");
      }
      await selected();
      remaining(timeoutMs, startedAt);
      // redact before display normalization truncates strings, including long credentials
      const redact = (value: string) => redactUsageError(value, auth.secrets);
      const redactString = (value: unknown) => typeof value === "string" ? redact(value) : value;
      const safePayload = { ...payload, plan_type: redactString(payload.plan_type),
        additional_rate_limits: Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits.map((item) => {
          const value = object(item);
          return value ? { ...value, metered_feature: redactString(value.metered_feature), limit_name: redactString(value.limit_name) } : item;
        }) : payload.additional_rate_limits,
      };
      const report = normalizeCodexBackendPayload(safePayload, Date.now());
      report.notes = report.notes?.map(redact);
      report.buckets = report.buckets.map((bucket) => ({ ...bucket, id: redact(bucket.id), label: redact(bucket.label),
        ...(bucket.groupId ? { groupId: redact(bucket.groupId) } : {}),
        ...(bucket.groupLabel ? { groupLabel: redact(bucket.groupLabel) } : {}),
        ...(bucket.modelKeys ? { modelKeys: bucket.modelKeys.map(redact) } : {}),
      }));
      return { ...report, providerId: "codex", providerName: "Codex (CLIProxyAPI)", source: "cliproxyapi-codex",
        semantics: { kind: "consumer-subscription", label: "Selected CLIProxyAPI account subscription limits" },
        accountLabel: account.target.label,
        notes: [...(report.notes ?? []),
          ...(account.userId && !account.accountId ? ["Token-default quota scope. The upstream user identity is verified, but no workspace account ID is available."] : []),
          "CLIProxyAPI selected proxy account. This is not a verified current inference account."],
      };
    },
  };
}

function quotaIdentity(payload: Record<string, unknown>): { userId: string; accountId: string } {
  const userId = validCodexAccountId(payload.user_id);
  const accountId = payload.account_id === "" ? "" : validCodexAccountId(payload.account_id);
  if (!userId || userId.trim() !== userId || accountId === undefined || accountId.trim() !== accountId) {
    throw new Error("CLIProxyAPI quota response lacks a valid user identity or account scope.");
  }
  return { userId, accountId };
}

function remaining(timeoutMs: number, startedAt: number): number {
  const value = timeoutMs - (Date.now() - startedAt);
  if (value <= 0) throw new Error("Timed out while querying CLIProxyAPI usage.");
  return value;
}
