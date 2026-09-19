# Local `apply_patch` extension

This Pi package provides a locally owned `apply_patch` tool. It follows the Codex patch format and uses exact context matching.

## Behavior

- Activates for OpenAI and Codex-like models
- Supports add, update, delete, and move actions
- Plans all file changes before it writes any file
- Uses Pi's per-file mutation queue
- Rejects ambiguous or missing update context
- Preserves CRLF line endings and missing final newlines during updates
- Rejects relative paths that leave the workspace
- Rejects workspace escapes through symbolic links
- Rejects add and move operations that overwrite an existing path
- Defers rendering to `pi-tool-renderer` or Pi's fallback renderer

The patch format follows the upstream Codex grammar:

<https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/apply_patch_tool_instructions.md>

## Installation

Add `../../Code/pi-extensions/packages/pi-apply-patch` to the `packages` array in `~/.pi/agent/settings.json`.

## Configuration

Edit `config.json` to allow absolute paths:

```json
{
  "allowAbsolutePaths": true
}
```

The default value is `false`. Relative paths must remain inside `ctx.cwd`, even when absolute paths are enabled.

A trusted project can override the global value with `.pi/apply-patch.json`:

```json
{
  "allowAbsolutePaths": false
}
```

## Reload

Run `/reload` in an active Pi session after you change the extension or its global configuration.

## Tests

Run the tests from this directory:

```fish
npm test
```
