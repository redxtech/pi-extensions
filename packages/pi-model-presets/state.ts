import type { ModelPreset, ThinkingLevel } from "./config.ts"

export type CycleDirection = "forward" | "backward"

export interface CurrentModelConfiguration {
  provider: string
  model: string
  thinkingLevel: ThinkingLevel
}

export interface ActivePreset extends CurrentModelConfiguration {
  name: string
  configuredThinkingLevel?: ThinkingLevel
}

export function configurationsMatch(
  active: ActivePreset,
  current: CurrentModelConfiguration | undefined,
): boolean {
  return current !== undefined
    && active.provider === current.provider
    && active.model === current.model
    && active.thinkingLevel === current.thinkingLevel
}

function findCurrentPresetIndex(
  presets: ModelPreset[],
  activeName: string | undefined,
  current: CurrentModelConfiguration | undefined,
): number {
  if (activeName !== undefined) {
    const activeIndex = presets.findIndex(
      (preset) => preset.name.toLowerCase()
        === activeName.toLowerCase(),
    )
    if (activeIndex >= 0) return activeIndex
  }

  if (!current) return -1

  const exactIndex = presets.findIndex(
    (preset) => preset.provider === current.provider
      && preset.model === current.model
      && preset.thinkingLevel === current.thinkingLevel,
  )
  if (exactIndex >= 0) return exactIndex

  return presets.findIndex(
    (preset) => preset.provider === current.provider
      && preset.model === current.model
      && preset.thinkingLevel === undefined,
  )
}

export function getCycleTarget(
  presets: ModelPreset[],
  activeName: string | undefined,
  current: CurrentModelConfiguration | undefined,
  direction: CycleDirection,
): ModelPreset | undefined {
  if (presets.length === 0) return undefined

  const currentIndex = findCurrentPresetIndex(presets, activeName, current)
  if (currentIndex < 0) {
    return direction === "forward" ? presets[0] : presets.at(-1)
  }

  const offset = direction === "forward" ? 1 : -1
  const targetIndex = (currentIndex + offset + presets.length) % presets.length
  return presets[targetIndex]
}
