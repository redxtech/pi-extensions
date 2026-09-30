# OpenAI subscription usage support

Investigation for the maintainer of Gabe's local `pi-usage` fork, dated 2026-09-30. This report assesses support for Pi's new `openai` subscription login alongside `openai-codex`. It does not implement support.

## Finding

The installed extension does not support the new provider. Pi loads `../../Code/pi-extensions/packages/pi-usage` from its user settings. The adapter registry recognizes `openai-codex`, but not `openai`. A direct import of `adapterForProvider` confirmed this result. [1]

The current model uses provider `openai`, API `openai-responses`, and model ID `openai-sub-new/gpt-6.1-sol` through Aperture. `openai-sub-new` is a gateway route prefix, not the Pi provider ID. Unsupported providers produce an unsupported state in `/usage` and clear the extension's statusline. [2]

This is not a provider-name alias change. The new login uses a different OAuth grant, and the existing usage endpoint rejected that grant in a read-only probe.

## Authentication and endpoint evidence

Pi's new OAuth flow requests resource `https://api.openai.com/v1` and scope `chatgpt.tokens.use.direct`. It stores `access`, `refresh`, `expires`, `clientId`, and `scopes`. The built-in `openai` provider also supports API-key authentication. An adapter must distinguish the subscription grant from an API key. [3][4]

The existing Codex adapter calls `GET https://chatgpt.com/backend-api/wham/usage`. It requires a token with `chatgpt_account_id`, an exactly matching complete OAuth credential, and a usage response whose `account_id` matches the selected account. Its proxy path forwards only the matched Bearer token and account header, not arbitrary gateway headers. [1][5]

A parent-run Node probe read the two existing credentials into memory and made one GET request per provider to that existing endpoint. It did not refresh credentials, send prompts, redeem resets, or change the auth file. It printed only booleans, HTTP statuses, and error classifications.

| Credential | Token expired | Account ID available | GET result |
|---|---|---|---|
| New `openai` OAuth | No | No, in either token or stored credential | HTTP 401, `rejected_by_access_enforcement`, `no_matching_rule` |
| Legacy `openai-codex` OAuth | No | Yes | HTTP 200, response account matched |

The auth file was unchanged at the end of the probe. These results describe the tested credentials and endpoint, not every possible OpenAI endpoint.

OpenAI's token reference specifies opaque encrypted authentication metadata for the new grant. It does not expose the legacy account claim used by this extension. The metadata must not be interpreted as an account ID. [6]

## Usage semantics and API gap

OpenAI documents that connected apps consume existing ChatGPT Work and Codex plan usage. Apps can also have their own weekly cap. A global plan balance therefore does not establish whether Pi can continue using its app-specific allowance. [7]

The official integration documentation examined here covers model discovery, Responses inference, usage-limit errors, and a browser link to ChatGPT Settings > Usage. It does not establish a programmatic remaining-allowance endpoint for this grant. The documented recovery for `subscription_sharing_usage_limit_exceeded` directs users to that settings page and warns against assuming the entire plan is empty or inferring a reset time. [8][9]

A quota API or verified quota-bearing response headers remain the prerequisite for accurate percentages and reset countdowns. Per-response token counts are not remaining subscription allowance. The failed legacy endpoint probe cannot be repaired by changing the report's provider label.

## Support options

### Supported guidance without numeric quota

A small change could recognize the new OAuth grant and show a clear explanation plus a Manage usage action for ChatGPT Settings > Usage. It must state that numeric allowance is unavailable rather than publish fabricated percentages. API-key users need a distinct explanation.

This option would touch the provider/auth classification and the `/usage` state or menu rendering. The current adapter contract assumes a query returns a report or fails, so a link-only outcome needs an explicit representation or a command-level branch. [1][2][10]

### Numeric quota support

The prerequisite is a documented or verified usage transport that accepts the new grant and identifies the account or app represented by its response. After that prerequisite is satisfied, the implementation scope is:

1. A separate `openai` subscription adapter, without treating all OpenAI API keys as subscription credentials
2. Fresh runtime authentication matched to a complete `openai` OAuth credential, with scope validation and fail-closed handling of conflicts
3. Proxy support for the current Aperture route that forwards only credentials authorized for the fixed usage origin
4. Request-boundary revalidation across account, model, session, and credential changes
5. A normalizer for the verified response schema, retaining separate plan and app limits when provided
6. Provider-aware report and statusline formatting, with cache identity that includes the OAuth registration when app limits depend on it
7. Focused tests and provider documentation

Likely code locations are `src/query.ts`, a provider normalizer, `src/types.ts`, `src/usage.ts`, and `src/format.ts`. The existing Codex normalizer and formatter hard-code `openai-codex`, so they cannot become new-provider support merely by registering another ID. [1][2][10][11]

Codex Fast mode and earned-reset redemption should remain outside the first read-only implementation. They have provider and endpoint restrictions independent of quota reporting. No support for either feature on the new grant was established. [12]

### Legacy account as an explicit separate view

The legacy credential still retrieved its usage in the probe. That is not proof that it belongs to the new connection or covers the new app cap. A future explicit separate-account view could retain value, but automatic fallback would violate the extension's current-account contract. The existing configured-provider path can also reject a legacy provider-wide proxy override, so an existing stored login alone does not establish that the menu can query it while `openai` is current. [1][5]

## Validation

- Direct adapter import: `openaiSupported: false`, `legacySupported: true`
- Read-only legacy-endpoint probe: new grant HTTP 401, legacy grant HTTP 200 with matching account
- Focused tests: `node --test --experimental-strip-types --test-name-pattern='(proxied Codex|unsupported|Codex)' packages/pi-usage/test/adapters.test.ts packages/pi-usage/test/core.test.ts packages/pi-usage/test/usage.test.ts`, 13 passed, 0 failed
- `git diff --check`: passed. The final report is untracked, so its whitespace was also checked separately
- Prose heuristic: `python /home/gabe/.pi/agent/skills/ste-writing/scripts/ste-lint.py packages/pi-usage/docs/openai-subscription-research.md`, completed with 24 heuristic flags and no em dashes. This is an explanation, not an STE procedure
- No implementation or configuration changes
- Full extension tests were not run because no implementation changed

Supplemental background research failed with `Subagent timed out after 240000ms.` Run `50ec9fde-2c01-44f4-95f4-fc5c8d50d3ef` ran in `/home/gabe/Code/pi-extensions` on `main` at `210f56d`, without a separate worktree. No completed research artifact was delivered. Inspection of the official DevKit and quota-bearing response headers remains incomplete. The parent did not retry or substitute another execution protocol. Repository inspection after failure found only this parent-authored report as an untracked change. The findings above rely on the parent's direct source review and read-only probe, not on an accepted child result.

Full numeric-support validation must cover direct and Aperture models, OAuth versus API-key auth, missing scopes, mismatched and conflicting credentials, account rotation, registration-specific cache isolation, redaction, redirects, malformed responses, cancellation, and legacy-provider regressions.

## Sources

[1] [Adapter registry, transport, and authentication](../src/query.ts), especially lines 48, 100-124, 332-497, and 911-1040

[2] [Usage state and statusline lifecycle](../src/usage.ts), especially lines 157-161 and 498-532. Local configuration: `~/.pi/agent/settings.json` and `~/.pi/agent/models.json`, inspected without printing credentials

[3] [Pi OpenAI OAuth source](https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/auth/oauth/openai-chatgpt.ts). Also verified against the installed Pi 0.99.1 implementation

[4] [Pi OpenAI provider source](https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/providers/openai.ts). Also verified against the installed Pi 0.99.1 implementation

[5] [Codex provider reference](./providers.md#openai-codex) and [legacy account-claim parser](../src/codex-account.ts)

[6] [OpenAI token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)

[7] [Sign in with ChatGPT user documentation](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)

[8] [OpenAI errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)

[9] [OpenAI integration example](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), especially its Manage usage section

[10] [Usage contracts](../src/types.ts) and [report formatting](../src/format.ts)

[11] [Codex payload normalizer](../src/providers/codex.ts)

[12] [Codex Fast restrictions](../src/codex-fast.ts) and [earned-reset authentication](../src/codex-resets.ts)
