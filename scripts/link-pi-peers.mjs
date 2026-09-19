import { accessSync, constants, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"

const CODING_AGENT = "@earendil-works/pi-coding-agent"
const PEERS = [
  CODING_AGENT,
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "typebox",
]

function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

function isPackageRoot(candidate) {
  return existsSync(join(candidate, "package.json"))
}

function packageRootFromExecutable(executable) {
  const candidates = [executable, join(dirname(executable), ".pi-wrapped_")]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue

    const resolvedExecutable = realpathSync(candidate)
    let current = dirname(resolvedExecutable)
    while (current !== dirname(current)) {
      if (isPackageRoot(current)) return current
      current = dirname(current)
    }

    const installRoot = dirname(dirname(resolvedExecutable))
    const installedPackage = join(installRoot, "lib", "node_modules", CODING_AGENT)
    if (isPackageRoot(installedPackage)) return installedPackage
  }
  return undefined
}

function findCodingAgentRoot() {
  const override = process.env.PI_PACKAGE_ROOT?.trim()
  if (override) {
    const candidate = resolve(override)
    if (!isPackageRoot(candidate)) {
      throw new Error(`PI_PACKAGE_ROOT does not contain package.json: ${candidate}`)
    }
    return realpathSync(candidate)
  }

  const executable = executableOnPath(process.platform === "win32" ? "pi.cmd" : "pi")
  const packageRoot = executable && packageRootFromExecutable(executable)
  if (packageRoot) return packageRoot

  throw new Error(
    "Cannot locate the active Pi package. Set PI_PACKAGE_ROOT to the @earendil-works/pi-coding-agent directory.",
  )
}

function findPeerRoot(codingAgentRoot, packageName) {
  if (packageName === CODING_AGENT) return codingAgentRoot

  const packageNodeModules = dirname(dirname(codingAgentRoot))
  const candidates = [
    join(codingAgentRoot, "node_modules", packageName),
    join(packageNodeModules, packageName),
  ]
  const match = candidates.find(isPackageRoot)
  if (!match) {
    throw new Error(`Cannot locate ${packageName} beside ${codingAgentRoot}`)
  }
  return realpathSync(match)
}

function linkPackage(repositoryRoot, packageName, source) {
  const target = join(repositoryRoot, "node_modules", packageName)
  mkdirSync(dirname(target), { recursive: true })

  let existing
  try {
    existing = lstatSync(target)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink dependency: ${target}`)
    }
    try {
      if (realpathSync(target) === source) return false
    } catch {}
    unlinkSync(target)
  }

  symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir")
  return true
}

const repositoryRoot = resolve(import.meta.dirname, "..")
const codingAgentRoot = findCodingAgentRoot()
let linked = 0
for (const packageName of PEERS) {
  const source = findPeerRoot(codingAgentRoot, packageName)
  if (linkPackage(repositoryRoot, packageName, source)) linked += 1
}

console.log(`Pi peer links ready (${linked} updated, ${PEERS.length - linked} unchanged)`)
