/**
 * Keyboard key names mapped to the WebDriver code points BiDi accepts.
 *
 * MEASURED: input.performActions rejects "Control"/"Enter"/"ArrowRight" outright
 * with `Expected "value" to be a string that represents single code point or
 * grapheme cluster`. Only single characters work, so named keys must become
 * their WebDriver code point before they are sent.
 */

/**
 * Map a human key name to the WebDriver codepoint BiDi accepts.
 *
 * MEASURED: input.performActions rejects "Control"/"Enter"/"ArrowRight" outright with
 * `Expected "value" to be a string that represents single code point or grapheme cluster`.
 * Only single characters work, so named keys must become their WebDriver codepoint.
 */
export const WEBDRIVER_KEYS: Record<string, string> = {
  NULL: '',
  Cancel: '',
  Help: '',
  Backspace: '',
  Tab: '',
  Clear: '',
  Return: '',
  Enter: '',
  Shift: '',
  Control: '',
  Alt: '',
  Pause: '',
  Escape: '',
  Space: '',
  PageUp: '',
  PageDown: '',
  End: '',
  Home: '',
  ArrowLeft: '',
  Left: '',
  ArrowUp: '',
  Up: '',
  ArrowRight: '',
  Right: '',
  ArrowDown: '',
  Down: '',
  Insert: '',
  Delete: '',
  Meta: '',
  Command: '',
}

export function webdriverKey(name: string): string {
  const mapped = WEBDRIVER_KEYS[name]
  if (mapped !== undefined) return mapped
  // Single character: use as-is. Function keys F1-F12 need their own codepoints (E031-E03C).
  if ([...name].length === 1) return name
  const fn = /^F([1-9]|1[0-2])$/.exec(name)
  if (fn) return String.fromCodePoint(0xe030 + Number(fn[1]))
  throw new Error('unknown key name: ' + name)
}
