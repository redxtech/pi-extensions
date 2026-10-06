import { randomBytes } from "node:crypto";
import { adapterForProvider, queryProviderUsage } from "../src/query.ts";
import { resolveCLIProxyCodexAuth } from "../src/providers/cliproxy-codex.ts";
import { listUsageTargets } from "../src/usage-targets.ts";
import type { PiModel } from "../src/types.ts";

const args = process.argv.slice(2);
if (args[0] !== "--live" || (args.length !== 1 && !(args.length === 3 && args[1] === "--account" && /^[1-9][0-9]*$/u.test(args[2]!)))) {
  console.error("Opt-in required: use --live, optionally followed by --account <listing ordinal>.");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const startedAt = Date.now();
  try {
    // no inference credentials or auth-file downloads are needed for this read-only smoke
    const model = { provider: "codex", id: "smoke", name: "Smoke" } as PiModel;
    const salt = randomBytes(32);
    const auth = resolveCLIProxyCodexAuth(model, salt);
    const adapter = adapterForProvider("codex")!;
    const guard = async () => {
      controller.signal.throwIfAborted();
      if (resolveCLIProxyCodexAuth(model, salt).fingerprint !== auth.fingerprint) throw new Error("Configuration changed.");
    };
    const remaining = () => {
      const value = 15000 - (Date.now() - startedAt);
      if (value <= 0) throw new Error("Deadline exceeded.");
      return value;
    };
    const targets = await listUsageTargets(adapter, auth, controller.signal, remaining(), guard);
    console.log(`Listing passed: ${targets.length} eligible Codex OAuth account(s). No account identities displayed.`);
    const ordinal = args[2] ? Number(args[2]) : targets.length === 1 ? 1 : undefined;
    if (!ordinal || !Number.isSafeInteger(ordinal) || !targets[ordinal - 1]) {
      console.error("Quota read not attempted. For multiple accounts, explicitly select a valid --account listing ordinal.");
      process.exitCode = 1;
    } else {
      const report = await queryProviderUsage(adapter, auth, controller.signal, remaining(), guard, targets[ordinal - 1]!.id);
      await guard();
      console.log(`Quota read passed: matched selected account, ${report.buckets.length} quota window(s), ${report.metrics.length} metric(s).`);
      console.log("Read-only CLIProxyAPI smoke passed. Current inference account identity was not verified.");
    }
  } catch {
    // do not print raw errors, responses, keys, tokens, or account metadata
    console.error("CLIProxyAPI smoke failed. Check the two management environment variables, transport trust, remote-management access, and account metadata.");
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
