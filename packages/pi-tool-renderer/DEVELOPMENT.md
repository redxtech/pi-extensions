# pi-tool-renderer development notes

Internals, design, and maintenance for the pi-tool-renderer Pi extension. Consumer docs live in [`README.md`](./README.md). Consumer-visible changes live in [`CHANGELOG.md`](./CHANGELOG.md).

## Install order

`index.ts` is the entry point. It guards against duplicate installation and returns when the `enabled` setting is off. It then creates renderer-only definitions and installs the tool-execution patch. The extension does not register or execute tools.

The extension enriches successful `edit` and `write` results with namespaced diff metadata when mutation rendering is enabled. Pi persists this metadata in the session. Restored tool rows can therefore render the original diff without replacing tool execution.

## Module layout

| Module | Responsibility |
| --- | --- |
| `index.ts` | Entry point and installation order. |
| `tool-renderer/tools.ts` | Renderer-only definitions for built-in tool names. |
| `tool-renderer/enrichment.ts` | Durable mutation diff metadata captured through tool events. |
| `tool-renderer/stack.ts` | Legacy stacking of consecutive native tool calls. |
| `tool-renderer/chrome.ts` | Tool chrome, the tool-execution renderer patch, and working indicators. |
| `tool-renderer/messages.ts` | Message renderers, custom spacing, and Markdown code blocks. |
| `tool-renderer/diff.ts` | Structured diffs, highlighting, and diff rendering. |
| `tool-renderer/generic.ts` | Generic, MCP, and `apply_patch` renderers. |
| `tool-renderer/images.ts` | Image rendering for `read` results. |
| `tool-renderer/overlay.ts` | Floating-overlay detection. |
| `tool-renderer/settings.ts` | Configuration access and project-trust checks. |
| `tool-renderer/live-settings.ts` | Live renderer refresh after setting changes. |
| `tool-renderer/glyphs.ts` | Unicode and ASCII glyph sets. |
| `tool-renderer/theme.ts` | Theme token fallbacks and tool labels. |
| `tool-renderer/text.ts` | Terminal normalization, previews, and line clipping. |
| `tool-renderer/ansi.ts` | ANSI and OSC helpers. |

## Terminal normalization

`normalizeTerminalText()` collapses CRLF and lone CR to `\n`, then delegates to the host's `normalizeTerminalOutput` when `@earendil-works/pi-tui` exposes it, so rendered text matches Pi's own normalization. Without that export it falls back to expanding tabs to three spaces. Line counting, splitting, and previews all route through it.

## Tests

Regression coverage lives in `__tests__/` and runs on `bun:test`. It covers rendering, mutation enrichment, terminal output, and installation without tool registration. Integration tests verify that old batch settings do not restore tool registration.

The suites import the host packages, which are optional peer dependencies, so install them before running:

```bash
cd ~/Code/pi-extensions/packages/pi-tool-renderer
bun test ./__tests__
```
