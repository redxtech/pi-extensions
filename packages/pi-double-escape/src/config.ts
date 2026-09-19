const DEFAULT_DEBOUNCE_MS = 1500
const MIN_DEBOUNCE_MS = 100
const MAX_DEBOUNCE_MS = 10_000

/** read the bounded confirmation interval from the process environment. */
export function getDebounceMs(
  env: Record<string, string | undefined>,
): number {
  const configured = env.PI_DOUBLE_ESCAPE_MS ?? env.PI_DOUBLE_ESC_MS
  if (configured === undefined) return DEFAULT_DEBOUNCE_MS

  const parsed = Number(configured)
  if (!Number.isFinite(parsed)) return DEFAULT_DEBOUNCE_MS

  return Math.min(
    MAX_DEBOUNCE_MS,
    Math.max(MIN_DEBOUNCE_MS, Math.round(parsed)),
  )
}
