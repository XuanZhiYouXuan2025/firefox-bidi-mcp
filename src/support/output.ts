import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const maxOutputChars = Number(process.env.DSH_BROWSER_MAX_OUTPUT_CHARS ?? 1_000_000)

export const outputDir = process.env.DSH_BROWSER_OUTPUT_DIR ?? tmpdir()

export type OutputKind = 'text' | 'png' | 'pdf'

// prettier-ignore
/**
 * Hand a result back to the caller.
 *
 * A big payload (a full-page PNG reaches ~1.8 MB of base64) would swamp the
 * model's context, so above the cap it is written to a file and the caller is
 * told where. Binary results are decoded first, so the file is a real PNG/PDF.
 */
export function text(value: string, kind: OutputKind = 'text') {
  if (value.length <= maxOutputChars) {
    return { content: [{ type: 'text' as const, text: value }] }
  }
  try {
    mkdirSync(outputDir, { recursive: true })
    const isBinary = kind === 'png' || kind === 'pdf'
    const body = isBinary ? value.slice(value.indexOf(',') + 1) : value
    const bytes = isBinary ? Buffer.from(body, 'base64') : Buffer.from(value, 'utf8')
    // A random suffix keeps two oversized results produced in the same
    // millisecond from overwriting each other.
    const file = join(
      outputDir,
      `dsh-browser-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}.${kind === 'text' ? 'txt' : kind}`,
    )
    writeFileSync(file, bytes)
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Output too large to return inline (${String(value.length)} characters, ${String(bytes.length)} bytes).` +
            String.fromCharCode(10) +
            `Written to: ${file}`,
        },
      ],
    }
  } catch (error) {
    // Falling back to truncation is better than failing the whole call.
    const omitted = value.length - maxOutputChars
    return {
      content: [
        {
          type: 'text' as const,
          text:
            value.slice(0, maxOutputChars) +
            String.fromCharCode(10) +
            `[truncated: ${String(value.length)} characters total, ${String(omitted)} omitted; ` +
            `writing to disk failed: ${error instanceof Error ? error.message : String(error)}]`,
        },
      ],
    }
  }
}

export function failure(error: unknown) {
  // MEASURED: some paths reject with a plain object, and String(object) is the
  // useless "[object Object]" — which is exactly what a Marionette failure once
  // reported, hiding the real cause. Serialise objects instead.
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null
        ? (() => {
            try {
              return JSON.stringify(error)
            } catch {
              return String(error)
            }
          })()
        : String(error)
  if (/Maximum number of active sessions/i.test(message)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'error: Firefox already has an active BiDi session (it allows only one). A previous client likely exited without ending its session; Firefox releases it only on restart. Fix: quit and restart that Firefox instance, then retry.',
        },
      ],
      isError: true,
    }
  }
  return { content: [{ type: 'text' as const, text: `error: ${message}` }], isError: true }
}
