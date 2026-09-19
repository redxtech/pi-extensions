# Changelog

## Consumer-impacting changes

### 1.8.0-local.1

- Copied the extension into the local Pi configuration.
- Replaced built-in tool registration with renderer-only integration.
- Added durable `edit` and `write` diff metadata through tool events.
- Kept `tool_batch` as the only registered tool.

### 1.8.0

- Added `registerReadTool`. Disable it when another extension such as `pi-hashline` owns `read`; compact rendering then attaches without replacing execution, hashline snapshot headers are summarized without being counted as file lines, and `tool_batch` rejects `read` rather than silently invoking Pi's built-in reader.

### 1.7.2

- Documentation only, no runtime change. This version ships what landed on main after 1.7.1 was published: the packaged README trimmed to the consumer contract — what the extension does, its settings, and setup — with contributor-facing internals moved to the unpublished `DEVELOPMENT.md` (#1473), and a `test` script in the manifest, `bun test ./extensions/__tests__`, which the repo's CI and `tools/validate-changed` now run (#1474). Published so the npm and pi.dev gallery pages carry the current copy; `extensions/` is byte-identical to 1.7.1.

### 1.7.1

- Baseline: changelog introduced at this version. Consumer-impacting changes — behavior deltas, new/renamed/removed exports, settings and config changes, protocol/audit-shape changes — are recorded here from this version forward.
