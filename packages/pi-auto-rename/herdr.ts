import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// cyber-mux does not expose label updates, so this compatibility path uses herdr
interface HerdrPaneInfo {
  readonly id: string
  readonly label?: string
  readonly tabId: string
}

interface HerdrTabInfo {
  readonly id: string
  readonly label?: string
  readonly number?: number
  readonly paneCount?: number
}

interface HerdrContext {
  readonly pane: HerdrPaneInfo
  readonly tab: HerdrTabInfo
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function extractPaneInfo(stdout: string): HerdrPaneInfo | undefined {
  const parsed = asRecord(JSON.parse(stdout) as unknown)
  const result = asRecord(parsed?.["result"])
  const pane = asRecord(result?.["pane"])
  const paneId = pane?.["pane_id"]
  const tabId = pane?.["tab_id"]

  if (
    typeof paneId !== "string" ||
    !paneId.trim() ||
    typeof tabId !== "string" ||
    !tabId.trim()
  ) {
    return undefined
  }

  const label = pane?.["label"]
  return {
    id: paneId,
    tabId,
    ...(typeof label === "string" ? { label } : {}),
  }
}

function extractTabInfo(stdout: string): HerdrTabInfo | undefined {
  const parsed = asRecord(JSON.parse(stdout) as unknown)
  const result = asRecord(parsed?.["result"])
  const tab = asRecord(result?.["tab"])
  const tabId = tab?.["tab_id"]

  if (typeof tabId !== "string" || !tabId.trim()) return undefined

  const label = tab?.["label"]
  const number = tab?.["number"]
  const paneCount = tab?.["pane_count"]
  return {
    id: tabId,
    ...(typeof label === "string" ? { label } : {}),
    ...(typeof number === "number" ? { number } : {}),
    ...(typeof paneCount === "number" ? { paneCount } : {}),
  }
}

async function getCurrentHerdrContext(): Promise<HerdrContext | undefined> {
  const paneId = process.env["HERDR_PANE_ID"]?.trim()
  if (!paneId) return undefined

  const { stdout: paneStdout } = await execFileAsync("herdr", [
    "pane",
    "get",
    paneId,
  ])
  const pane = extractPaneInfo(paneStdout)
  if (!pane) return undefined

  const { stdout: tabStdout } = await execFileAsync("herdr", [
    "tab",
    "get",
    pane.tabId,
  ])
  const tab = extractTabInfo(tabStdout)
  return tab ? { pane, tab } : undefined
}

function isTemporaryHerdrLabel(label: string | undefined): boolean {
  const temporaryLabel = process.env["HERDR_TEMPORARY_LABEL"]?.trim()
  return Boolean(temporaryLabel) && label?.trim() === temporaryLabel
}

function isDefaultHerdrTabLabel(tab: HerdrTabInfo): boolean {
  const label = tab.label?.trim()
  if (!label) return true
  return typeof tab.number === "number" && label === String(tab.number)
}

function canRenameSessionStart(context: HerdrContext): boolean {
  const singlePane = context.tab.paneCount === 1
  const label = singlePane ? context.tab.label : context.pane.label
  return (
    (singlePane ? isDefaultHerdrTabLabel(context.tab) : !label?.trim()) ||
    isTemporaryHerdrLabel(label)
  )
}

async function renameHerdrTarget(
  context: HerdrContext,
  name: string,
): Promise<boolean> {
  await execFileAsync("herdr", ["pane", "rename", context.pane.id, name])
  if (context.tab.paneCount === 1) {
    await execFileAsync("herdr", ["tab", "rename", context.tab.id, name])
  }
  return true
}

export async function renameCurrentHerdrTarget(
  name: string,
): Promise<boolean> {
  const context = await getCurrentHerdrContext()
  return context ? renameHerdrTarget(context, name) : false
}

export async function renameCurrentHerdrTargetIfDefault(
  name: string,
): Promise<boolean> {
  const context = await getCurrentHerdrContext()
  if (
    !context ||
    !canRenameSessionStart(context) ||
    context.tab.label?.trim() === name ||
    context.pane.label?.trim() === name
  ) {
    return false
  }

  return renameHerdrTarget(context, name)
}
