export const DEFAULT_RENAME_LANGUAGE = "en"
export type RenameLanguage = string

export function parseRenameLanguage(
  value: unknown,
): RenameLanguage | undefined {
  if (typeof value !== "string") return undefined

  const trimmed = value.trim()
  if (trimmed.toLowerCase() === "auto") return "auto"
  if (!trimmed) return undefined

  try {
    return Intl.getCanonicalLocales(trimmed)[0]
  } catch {
    // invalid BCP 47 tags are ordinary command input errors
    return undefined
  }
}
