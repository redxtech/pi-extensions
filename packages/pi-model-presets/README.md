# Model presets extension

Reference for the global model presets extension.

## Configuration

The extension reads `~/.pi/agent/model-presets.json` when Pi loads or reloads extensions.

```json
{
  "presets": [
    {
      "name": "default",
      "provider": "openai-codex",
      "model": "gpt-5.6-sol",
      "thinkingLevel": "high"
    }
  ],
  "keybindings": {
    "next": "tab",
    "previous": "shift+tab"
  },
  "ui": {
    "status": true,
    "notifications": true
  }
}
```

### Preset fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Unique, case-insensitive preset name |
| `provider` | string | yes | Exact Pi provider ID |
| `model` | string | yes | Exact model ID for the provider |
| `thinkingLevel` | string | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

When `thinkingLevel` is absent, Pi applies the target model's configured default. A per-model default takes priority over the global default.

### Keybinding fields

| Field | Default | Description |
| --- | --- | --- |
| `next` | `tab` | Cycle forward when the editor is empty and Pi is idle |
| `previous` | `shift+tab` | Cycle backward when the editor is empty and Pi is idle |

A `null` value disables that direction. The extension forwards both keys to the existing editor when the editor contains text, autocomplete is visible, or Pi is busy.

### UI fields

| Field | Default | Description |
| --- | --- | --- |
| `status` | `true` | Show `preset:<name>` through Pi's composable footer status API |
| `notifications` | `true` | Show activation and error notifications |

Set both fields to `false` to disable passive UI output.

## Interfaces

| Interface | Behavior |
| --- | --- |
| `/preset` | Open the preset selector |
| `/preset <name>` | Activate a preset by name |
| `--preset <name>` | Activate a preset when a session starts |
| Forward keybinding | Activate the next preset and wrap at the end |
| Backward keybinding | Activate the previous preset and wrap at the start |

The extension clears the active indicator after a manual model or thinking-level change makes the current configuration differ from the selected preset. Session entries preserve the selected preset across reloads and resumes.

## UI composition

The extension decorates the current editor instead of replacing its input behavior. It delegates non-cycling input to the previous editor implementation. The persistent indicator uses `ctx.ui.setStatus()` and does not replace the footer or add a widget.

Pi applies editor factories in extension load order. The `pi-model-presets` package therefore follows `pi-open-tui` and `pi-double-escape` in `settings.json`.
