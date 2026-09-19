# @gabedunn/pi-auto-rename

Generate a Pi session name after the first user message. When Pi runs inside Herdr, the extension also updates the active target label.

## Commands

- `/rename` generates and applies a session name
- `/rename status` shows the selected model and language
- `/rename config` selects the rename model
- `/rename config language <auto|BCP-47>` selects the name language
- `/rename help` shows command help

The extension stores its model and language preferences in the Pi agent directory. It keeps startup quiet when Herdr is unavailable.

## Provenance

This extension replaced a previous integration with `@tifan/pi-rename`. The current implementation is maintained locally.
