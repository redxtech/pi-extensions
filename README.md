# Pi extensions

Personal Pi extensions maintained by Gabe Dunn.

Pi loads each package from `~/.pi/agent/settings.json` by a local path. The package entries remain separate because editor extensions require a specific load order.

## Packages

| Package | Purpose |
| --- | --- |
| `pi-apply-patch` | Provide the `apply_patch` tool with strict Codex patch parsing |
| `pi-auto-rename` | Name Pi sessions and their active Herdr targets |
| `pi-double-escape` | Require a second Escape press before an active run stops |
| `pi-model-presets` | Select model and thinking-level presets |
| `pi-tool-renderer` | Render tools and messages with compact terminal output |
| `pi-usage` | Show provider usage, DeepSeek API balance, and Codex Fast mode |

## Development

Run all available package tests from the repository root:

```fish
npm test
```

The test command links Pi's bundled peer packages into the ignored `node_modules` directory. It finds them from the active `pi` executable.

Set `PI_PACKAGE_ROOT` to the `@earendil-works/pi-coding-agent` directory when automatic detection does not work:

```fish
set -x PI_PACKAGE_ROOT /path/to/@earendil-works/pi-coding-agent
npm run bootstrap
```

The `pi-tool-renderer` tests also require Bun.

## Provenance

- `pi-apply-patch` started as a local implementation of behavior from `pi-codex-minimal-tools`.
- `pi-auto-rename` replaced an earlier integration with `@tifan/pi-rename`.
- `pi-tool-renderer` is a modified version of the MIT-licensed renderer from [vstack](https://github.com/vanillagreencom/vstack).
- `pi-double-escape` and `pi-model-presets` are local extensions.
- `pi-usage` is a local fork of `@narumitw/pi-usage` from [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions), with the upstream `@narumitw/pi-tui-kit` menu runtime vendored into `packages/pi-usage/src/kit` and the vitest suite ported to `node --test`.

The first import came from commits `e9ac697`, `1397af6`, `79ef773`, `7ab90be`, and `b1e5cc1` in the previous Pi configuration repository.
