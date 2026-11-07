/** Reject empty/non-string arguments with a message that names the field. */
export const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}
