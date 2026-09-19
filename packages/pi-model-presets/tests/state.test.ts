import assert from "node:assert/strict"
import test from "node:test"
import type { ModelPreset } from "../config.ts"
import {
  configurationsMatch,
  getCycleTarget,
  type ActivePreset,
  type CurrentModelConfiguration,
} from "../state.ts"

const presets: ModelPreset[] = [
  {
    name: "fast",
    provider: "provider-a",
    model: "model-a",
    thinkingLevel: "low",
  },
  {
    name: "default",
    provider: "provider-b",
    model: "model-b",
  },
  {
    name: "deep",
    provider: "provider-c",
    model: "model-c",
    thinkingLevel: "high",
  },
]

test("cycles from the active preset and wraps in both directions", () => {
  assert.equal(
    getCycleTarget(presets, "deep", undefined, "forward")?.name,
    "fast",
  )
  assert.equal(
    getCycleTarget(presets, "fast", undefined, "backward")?.name,
    "deep",
  )
})

test("starts at the first or last preset when the current model is unmatched", () => {
  const current: CurrentModelConfiguration = {
    provider: "other",
    model: "other",
    thinkingLevel: "medium",
  }

  assert.equal(
    getCycleTarget(presets, undefined, current, "forward")?.name,
    "fast",
  )
  assert.equal(
    getCycleTarget(presets, undefined, current, "backward")?.name,
    "deep",
  )
})

test("uses the current model as the cycle position", () => {
  const current: CurrentModelConfiguration = {
    provider: "provider-b",
    model: "model-b",
    thinkingLevel: "xhigh",
  }

  assert.equal(
    getCycleTarget(presets, undefined, current, "forward")?.name,
    "deep",
  )
  assert.equal(
    getCycleTarget(presets, undefined, current, "backward")?.name,
    "fast",
  )
})

test("active state requires provider, model, and resolved thinking to match", () => {
  const active: ActivePreset = {
    name: "default",
    provider: "provider-b",
    model: "model-b",
    thinkingLevel: "high",
  }

  assert.equal(
    configurationsMatch(active, {
      provider: "provider-b",
      model: "model-b",
      thinkingLevel: "high",
    }),
    true,
  )
  assert.equal(
    configurationsMatch(active, {
      provider: "provider-b",
      model: "model-b",
      thinkingLevel: "low",
    }),
    false,
  )
})
