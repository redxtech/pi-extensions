import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after, beforeEach } from "node:test"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent"

const agentDir = mkdtempSync(join(tmpdir(), "pi-auto-rename-extension-"))
const previousAgentDir = process.env.PI_CODING_AGENT_DIR
const previousPaneId = process.env.HERDR_PANE_ID
process.env.PI_CODING_AGENT_DIR = agentDir
delete process.env.HERDR_PANE_ID
const { default: autoRename } = await import("../index.ts")
const configPath = join(agentDir, "extensions", "pi-rename.json")
const preferences = [
  { provider: "provider-a", id: "first" },
  { provider: "provider-b", id: "second" },
]

beforeEach(() => rmSync(configPath, { recursive: true, force: true }))
after(() => {
  rmSync(agentDir, { recursive: true, force: true })
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID
  else process.env.HERDR_PANE_ID = previousPaneId
})

function fixture(steps: readonly (string | undefined)[] = []) {
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined
  let sessionStart: ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>) | undefined
  const notifications: { text: string; level: string }[] = []
  const names: string[] = []
  const requests: string[] = []
  let index = 0
  autoRename({
    registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler },
    on(event: string, handler: typeof sessionStart) {
      if (event === "session_start") sessionStart = handler
    },
    getSessionName() { return undefined },
    setSessionName(name: string) { names.push(name) },
  } as unknown as ExtensionAPI)
  const ctx = {
    hasUI: true, mode: "rpc", signal: undefined,
    ui: {
      notify(text: string, level: string) { notifications.push({ text, level }) },
      async select(_title: string, choices: string[]) {
        assert.ok(index < steps.length)
        const selection = steps[index++]
        assert.ok(selection === undefined || choices.includes(selection))
        return selection
      },
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: [{ role: "user", content: "Fix the latest bug", timestamp: 0 }] }
      },
    },
    modelRegistry: {
      getAll() { return preferences.map((model) => ({ ...model, input: ["text"] })) },
      find(provider: string, id: string) {
        return preferences.find((item) => item.provider === provider && item.id === id)
          ? { provider, id, input: ["text"] }
          : undefined
      },
      async getProviderAuth() { return { auth: { apiKey: "test" } } },
      async complete(model: { id: string }) {
        requests.push(model.id)
        if (requests.length === 1) throw new Error("first request failed")
        return { stopReason: "stop", content: [{ type: "text", text: "successful-name" }] }
      },
    },
  } as unknown as ExtensionCommandContext
  return {
    ctx, notifications, names, requests,
    async start() {
      assert.ok(sessionStart)
      await sessionStart({ reason: "reload" } as SessionStartEvent, ctx)
    },
    async run(args: string) {
      assert.ok(command)
      await command(args, ctx)
    },
  }
}

test("the config command saves ordered models and updates the in-session preference", async () => {
  const f = fixture(["[ ] provider-b/second", "[ ] provider-a/first", "Save model order"])
  await f.run("config")
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { models: ["provider-b/second", "provider-a/first"] })
  await f.run("status")
  assert.match(f.notifications.at(-1)!.text, /selected models: provider-b\/second → provider-a\/first/)
  assert.match(f.notifications.at(-1)!.text, /available models: provider-b\/second → provider-a\/first/)
})

test("a reloaded extension tries the saved models in order and applies one name", async () => {
  mkdirSync(join(agentDir, "extensions"), { recursive: true })
  writeFileSync(configPath, JSON.stringify({ models: ["provider-b/second", "provider-a/first"] }))
  const f = fixture()
  await f.start()
  await f.run("")
  assert.deepEqual(f.requests, ["second", "first"])
  assert.deepEqual(f.names, ["successful-name"])
  assert.deepEqual(f.notifications.at(-1), { text: "Session renamed: successful-name", level: "info" })
})

test("cancelling the config command leaves the saved preference unchanged", async () => {
  mkdirSync(join(agentDir, "extensions"), { recursive: true })
  const saved = { models: ["provider-a/first"], language: "fr" }
  writeFileSync(configPath, JSON.stringify(saved))
  const f = fixture(["[ ] provider-b/second", undefined])
  await f.start()
  await f.run("config")
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), saved)
  await f.run("status")
  assert.match(f.notifications.at(-1)!.text, /selected models: provider-a\/first\n/)
})

test("a failed config write leaves the in-session model order unchanged", async () => {
  const f = fixture(["[ ] provider-b/second", "Save model order"])
  mkdirSync(configPath, { recursive: true })
  await f.run("config")
  assert.equal(f.notifications.at(-1)?.level, "error")
  await f.run("status")
  assert.match(f.notifications.at(-1)!.text, /selected models: default/)
})
