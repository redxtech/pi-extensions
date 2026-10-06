# @gabedunn/pi-auto-rename

Generate a Pi session name after the first user message. When Pi runs inside Herdr, the extension also updates the active target label.

## Commands

- `/rename` generates and applies a session name
- `/rename status` shows the ordered model list, available models, and language
- `/rename config` selects the rename models in order
- `/rename config language <auto|BCP-47>` selects the name language
- `/rename help` shows command help

The extension keeps startup quiet when Herdr is unavailable.

## Configuration

Preferences are stored in `extensions/pi-rename.json` inside the Pi agent directory, normally `~/.pi/agent`.

```json
{
  "models": [
    "codex/codex-proxy/gpt-6-luna",
    "anthropic/claude-sonnet-4-5"
  ],
  "language": "auto"
}
```

`models` is a non-empty list of `provider/model-id` strings. Model IDs can contain `/`. The extension tries models sequentially in list order and stops at the first non-empty name from a successful response. Unavailable models, authentication errors, request errors, timeouts, and unusable responses advance to the next model. Each request retains the 30-second timeout and disables retries.

The text fallback runs only after all models fail. An invalid configuration also uses the text fallback. Cancellation stops the sequence without a rename.

Without a model preference, the default is `codex/codex-proxy/gpt-6-luna`. Existing `model` strings remain supported as one-item lists. When both fields exist, `models` takes precedence. Saving a model list removes the legacy `model` field.

The `/rename config` picker marks selected models with their attempt numbers. Enter adds or removes a model. New selections go last. Removing and selecting a model again moves it last. `Save model order` saves a non-empty list. `Use default` removes both model preference fields. Escape cancels without saving. Search filters the choices without changing the order.

## Provenance

This extension replaced a previous integration with `@tifan/pi-rename`. The current implementation is maintained locally.
