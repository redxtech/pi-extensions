import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after, beforeEach } from "node:test"

const agentDir = mkdtempSync(join(tmpdir(), "pi-auto-rename-"))
const previousAgentDir = process.env.PI_CODING_AGENT_DIR
process.env.PI_CODING_AGENT_DIR = agentDir
const {
  deleteModelPreference,
  formatModelPreference,
  getRenameModelPreferences,
  resolveInitialRenameConfig,
  saveModelPreferences,
  saveRenameLanguage,
} = await import("../models.ts")

const configPath = join(agentDir, "extensions", "pi-rename.json")
const first = { provider: "provider-a", id: "model/first" }
const second = { provider: "provider-b", id: "second" }

function writeConfig(config: unknown): void {
  mkdirSync(join(agentDir, "extensions"), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config))
}

beforeEach(() => rmSync(configPath, { force: true }))
after(() => {
  rmSync(agentDir, { recursive: true, force: true })
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
})

test("uses codex/codex-proxy/gpt-6-luna when preferences are missing", () => {
  const state = resolveInitialRenameConfig()
  assert.equal(state.modelConfig.kind, "missing")
  assert.deepEqual(getRenameModelPreferences(state.modelConfig), [
    { provider: "codex", id: "codex-proxy/gpt-6-luna" },
  ])
})

test("parses an ordered model list and IDs containing slashes", () => {
  writeConfig({ models: [" provider-a/model/first ", "provider-b/second"], language: "fr" })
  const state = resolveInitialRenameConfig()
  assert.deepEqual(state.modelConfig, { kind: "configured", models: [first, second] })
  assert.equal(state.language, "fr")
  assert.equal(formatModelPreference(state.modelConfig), "provider-a/model/first → provider-b/second")
})

test("reads legacy single-model preferences", () => {
  writeConfig({ model: "provider-a/model/first" })
  assert.deepEqual(resolveInitialRenameConfig().modelConfig, { kind: "configured", models: [first] })
})

test("the list takes precedence over a legacy model", () => {
  writeConfig({ model: "provider-a/model/first", models: ["provider-b/second"] })
  assert.deepEqual(resolveInitialRenameConfig().modelConfig, { kind: "configured", models: [second] })
})

for (const models of [[], null, "provider-a/first", [42], ["missing-separator"], ["/id"], ["provider/"], ["provider/valid", null]]) {
  test(`rejects malformed model lists: ${JSON.stringify(models)}`, () => {
    writeConfig({ models, model: "provider-a/model/first", language: "fr" })
    const state = resolveInitialRenameConfig()
    assert.deepEqual(state.modelConfig, { kind: "invalid" })
    assert.deepEqual(getRenameModelPreferences(state.modelConfig), [])
    assert.equal(state.language, "fr")
  })
}

test("handles invalid JSON without selecting the default model", () => {
  writeConfig({})
  writeFileSync(configPath, "{")
  assert.deepEqual(resolveInitialRenameConfig().modelConfig, { kind: "invalid" })
})

test("saves ordered models, removes the legacy field, and preserves unrelated preferences", () => {
  writeConfig({ model: "old/model", language: "fr", unrelated: true })
  saveModelPreferences([second, first])
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    models: ["provider-b/second", "provider-a/model/first"], language: "fr", unrelated: true,
  })
  assert.deepEqual(resolveInitialRenameConfig().modelConfig, { kind: "configured", models: [second, first] })
})

test("creates the preference file and preserves models when changing language", () => {
  saveModelPreferences([first, second])
  saveRenameLanguage("fr")
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    models: ["provider-a/model/first", "provider-b/second"], language: "fr",
  })
})

test("rejects an empty model list before writing", () => {
  writeConfig({ language: "fr" })
  assert.throws(() => saveModelPreferences([]), /non-empty list/)
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { language: "fr" })
})

test("reset removes both model fields and preserves language", () => {
  writeConfig({ model: "old/model", models: ["provider-a/first"], language: "fr" })
  deleteModelPreference()
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { language: "fr" })
  assert.equal(resolveInitialRenameConfig().modelConfig.kind, "missing")
})

test("reset deletes an otherwise empty file and tolerates a missing file", () => {
  writeConfig({ models: ["provider-a/first"] })
  deleteModelPreference()
  assert.equal(existsSync(configPath), false)
  deleteModelPreference()
})
