# pi-tool-renderer

Display-only renderers for Pi tools and messages, with optional rich mutation diffs. The package does not register or execute tools.

## Highlights

- Compact one-line tool rows for `read`, `bash`, `grep`, `find`, `ls`; file paths in compact rows use OSC 8 `file://` hyperlinks when the terminal supports them.
- Hashline-aware `read` summaries and previews when another extension owns the tool.
- Delayed live bash tails avoid fast-command output flashes; long-running commands show/preserve the last few lines flush-left so copied output has no gutter characters.
- Pi-compatible terminal normalization handles CRLF/lone-CR line endings and expands visible tabs to three columns.
- Optional rich Shiki diffs for `edit`/`write` with side-by-side previews, hunk counts, and inline word highlights.
- Compact user-message cards with a green border and red π marker.
- Compaction summaries and skill invocations render with the same compact chrome.
- Generic renderers for OpenAI-style tools (`web_search`, `webfetch`, `Agent`, `Task*`) and MCP tools.
- `apply_patch` call/result preview when the tool is present.

Defaults leave `edit`/`write` on Pi's built-in renderers. Enable **Render edits/writes compactly** to opt in.

Compact rendering attaches to the selected `read` provider without replacing it.

## Install

This extension is maintained in `~/Code/pi-extensions/packages/pi-tool-renderer`. It is modified from the MIT-licensed renderer in the [vstack](https://github.com/vanillagreencom/vstack) project.

Add `../../Code/pi-extensions/packages/pi-tool-renderer` to the `packages` array in `~/.pi/agent/settings.json`. Restart Pi after changes.

## Settings

Open `/extensions:settings`; settings appear under the **Tool Renderer** tab.

Project settings in `.pi/settings.json` apply only after Pi marks the workspace trusted; before trust, vstack Pi extensions read user/global settings only.

Glyph style: each package exposes `glyphStyle` (`unicode` default, `ascii` for terminal-safe chrome). `@gabedunn/pi-tool-renderer.globalGlyphStyleOverride=ascii` forces ASCII chrome across vstack Pi extensions while leaving tool/model/user content unchanged.

| Group | Setting | What it does |
| --- | --- | --- |
| General | Enable compact renderers | Apply compact read, bash, and search rendering without replacing tool definitions. |
| General | Tree connector style | `unicode` or `ascii`. |
| General | Stack separate native tool calls | Group consecutive native tool rows. Disabled by default because Pi reserves hidden sibling layout space. |
| General | Stack child display | `rows`, `headline`, or `anchor-list` when stacking is on. |
| Messages | Compact user messages | Green border + red π marker instead of filled background; preserves Pi's prompt-zone markers around the full framed card. |
| Messages | User message trailing blank line | Extra blank line after user messages. |
| Messages | Compact compaction summaries | Compact bullet style instead of Pi's padded box. |
| Messages | Compact skill invocation messages | Compact `/skill:name` rows. |
| Messages | Align assistant messages | Remove Pi's one-column left padding from assistant text. |
| Messages | Styled markdown code blocks | Render fenced code blocks with syntax highlighting and background, flush-left with no copy gutter/prefix. |
| Read / Search / Bash output | Read output mode | `preview`, `summary`, or `hidden`. |
| Read / Search / Bash output | Read image display | `off`, `always`, or `on` (expanded-only); requires Pi `terminal.showImages=false`. |
| Read / Search / Bash output | Search output mode | `preview`, `count`, or `hidden`. |
| Read / Search / Bash output | Bash output mode | `opencode`, `preview`, `summary`, or `hidden`. |
| Read / Search / Bash output | Live bash output delay (ms) | Wait this long before showing a running bash output tail. |
| Read / Search / Bash output | Live bash tail lines | Tail lines shown for long-running bash output and kept after completion. |
| Read / Search / Bash output | Expanded read/search/bash preview lines | Per-tool expand-time line caps. |
| Read / Search / Bash output | Command preview characters | Max command chars in collapsed bash rows. |
| Read / Search / Bash output | Collapsed bash preview lines | Tail lines shown when `bashOutputMode=preview`. |
| Bash diffs | Render bash diffs | Detect diff output from read-only bash and render rich diff UI. Off by default. |
| Bash diffs | Render git diff command diffs | Show rich diff UI for explicit `git diff` commands. Off by default. |
| Mutation (edit/write) | Render edits/writes compactly | Apply compact renderers and persist diff metadata for session restoration. Off by default. |
| Mutation (edit/write) | Split diff view | Side-by-side rich diffs on wide terminals. |
| Mutation (edit/write) | Collapsed / expanded diff preview lines | Line budgets for collapsed and expanded rows. |
| Mutation (edit/write) | Edit/write call preview | Show safe call-phase diff previews before execution completes. |
| Mutation (edit/write) | Edit/write call preview lines | Line budget for call-phase previews. |
| Mutation (edit/write) | Syntax-highlight diffs | Use Shiki when a language can be detected. |
| Mutation (edit/write) | Inline word diff highlights | Highlight changed words in paired removed/added lines. |
| Mutation (edit/write) | Diff line backgrounds | Fill added/removed lines with success/error backgrounds. |
| Mutation (edit/write) | Show diff hunk metadata | Include hunk counts and truncation hints. |
| Generic tools | Generic external tool renderers | Render `web_search`, `webfetch`, `Agent`, `Task*` and similar. |
| Generic tools | Render apply_patch | Install `apply_patch` call/result renderers without changing execution. |
| Generic tools | apply_patch call preview | Parse arguments and render diff previews during the call phase. |
| Generic tools | apply_patch preview lines | Line budget for collapsed `apply_patch` diffs. |
| Generic tools | MCP output mode | `preview`, `summary`, or `hidden`. |
| Generic tools | MCP preview lines | Line budget for MCP/generic tool previews. |
| Chrome | Global tool chrome | `off`, `transparent`, or `outlines` (muted horizontal rules above/below), including tools that render their own shell. |
| Chrome | Guard terminal right margin | Render one column short to avoid auto-wrap flashes in tmux. |
| Chrome | Animate pending tool status | Blink pending bullets. Off for stable streaming. |
| Chrome | Working indicator | `default`, `pulse`, or `hidden`. |
| Safety | Max renderer line width | Hard cap for single rendered lines. |

## Notes

The extension changes presentation without replacing tool definitions or execution. Optional mutation rendering adds diff metadata to results for session restoration.

`tool_batch` and its settings (`registerBatchTool`, `batchMaxCalls`, and `batchCallTimeoutMs`) have been removed. Existing values are ignored.

Contributor-facing module layout and regression coverage are in [`DEVELOPMENT.md`](./DEVELOPMENT.md).
