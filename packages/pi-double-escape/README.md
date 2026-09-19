# @gabedunn/pi-double-escape

Require a second Escape press before Pi interrupts an active agent operation.

The package composes with the current editor. It preserves editors supplied by `pi-open-tui` and other extensions.

## Behavior

- The first Escape press shows `esc again to abort` in the extension status area.
- A second Escape press within 1.5 seconds invokes the editor's normal interrupt behavior.
- Escape works normally while Pi is idle.
- Escape dismisses autocomplete with one press.
- Any other key or a timeout clears the pending interrupt.

## Installation

Install the local package after editor packages such as `pi-open-tui`:

```fish
pi install ./packages/pi-double-escape
```

Package order matters. The package must load after the editor that it decorates.

## Configuration

Set `PI_DOUBLE_ESCAPE_MS` to change the confirmation interval:

```fish
set -x PI_DOUBLE_ESCAPE_MS 2000
pi
```

The older `PI_DOUBLE_ESC_MS` name also works.

Values are limited to 100 through 10000 milliseconds.

## Design

On `session_start`, the package gets the current editor factory with `ctx.ui.getEditorComponent()`. It calls that factory to create the editor.

The package decorates the editor's `handleInput()` method. Rendering, cursor behavior, autocomplete, keybindings, and editor state remain with that instance.
