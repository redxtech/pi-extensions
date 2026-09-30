export function validCodexAccountId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 512) return undefined;
  if (/[^\x20-\x7e]/u.test(value)) return undefined;
  return value;
}

export function codexAccountIdFromAccessToken(access: string): string | undefined {
  try {
    const parts = access.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const claims = (payload as Record<string, unknown>)["https://api.openai.com/auth"];
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return undefined;
    return validCodexAccountId((claims as Record<string, unknown>).chatgpt_account_id);
  } catch {
    return undefined;
  }
}
