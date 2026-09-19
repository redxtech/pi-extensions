import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { parseConfig } from "../config.ts"

test("parses presets and applies configuration defaults", () => {
  const result = parseConfig({
    presets: [
      {
        name: "default",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
      },
    ],
  })

  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.config, {
    presets: [
      {
        name: "default",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
      },
    ],
    keybindings: {
      next: "tab",
      previous: "shift+tab",
    },
    ui: {
      status: true,
      notifications: true,
    },
  })
})

test("accepts disabled keybindings and UI", () => {
  const result = parseConfig({
    presets: [],
    keybindings: {
      next: null,
      previous: "alt+p",
    },
    ui: {
      status: false,
      notifications: false,
    },
  })

  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.config.keybindings, {
    next: null,
    previous: "alt+p",
  })
  assert.deepEqual(result.config.ui, {
    status: false,
    notifications: false,
  })
})

test("rejects invalid thinking levels", () => {
  const result = parseConfig({
    presets: [
      {
        name: "deep",
        provider: "provider-a",
        model: "model-a",
        thinkingLevel: "maximum",
      },
    ],
  })

  assert.deepEqual(result.config.presets, [])
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0]!, /thinkingLevel/)
})

test("rejects duplicate names case-insensitively", () => {
  const result = parseConfig({
    presets: [
      {
        name: "Deep",
        provider: "provider-a",
        model: "model-a",
      },
      {
        name: "deep",
        provider: "provider-b",
        model: "model-b",
      },
    ],
  })

  assert.deepEqual(result.config.presets, [
    {
      name: "Deep",
      provider: "provider-a",
      model: "model-a",
    },
  ])
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0]!, /must be unique/)
})

test("disables the previous binding when both bindings are equal", () => {
  const result = parseConfig({
    presets: [],
    keybindings: {
      next: "ctrl+k",
      previous: "ctrl+k",
    },
  })

  assert.deepEqual(result.config.keybindings, {
    next: "ctrl+k",
    previous: null,
  })
  assert.match(result.issues[0]!, /must differ/)
})

test("loads after packages that replace or decorate the editor", () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
    packages?: Array<string | { source: string }>
  }
  const packages = settings.packages ?? []
  const packageIndex = (name: string) => packages.findIndex((entry) => {
    const source = typeof entry === "string" ? entry : entry.source
    const normalized = source.replaceAll("\\", "/")
    return source === `npm:${name}` || normalized.endsWith(`/${name}`)
  })
  const openTuiIndex = packageIndex("pi-open-tui")
  const doubleEscapeIndex = packageIndex("pi-double-escape")
  const presetIndex = packageIndex("pi-model-presets")

  assert.ok(openTuiIndex >= 0, "pi-open-tui is configured")
  assert.ok(doubleEscapeIndex > openTuiIndex, "pi-double-escape loads after pi-open-tui")
  assert.ok(presetIndex > doubleEscapeIndex, "pi-model-presets loads after pi-double-escape")
})
