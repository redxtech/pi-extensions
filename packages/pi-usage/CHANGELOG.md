# @gabedunn/pi-usage

## 0.1.0

Initial local release.

- Imported from upstream `@narumitw/pi-usage` 0.60.8.
- Removed the `@narumitw/pi-tui-kit` dependency by vendoring a pruned subset of its menu runtime into `src/menu/`.
- Removed the esbuild build pipeline; Pi loads `src/index.ts` directly.
- Ported the test suite from vitest to plain `node --test` with a vendored `vi` shim in `test/vi-shim.ts`.
- Renamed the package to `@gabedunn/pi-usage` and made it private.

Upstream release history before this fork documented behavior through 0.60.8; the imported sources retain that behavior.