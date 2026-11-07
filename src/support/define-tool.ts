import type { McpServer } from '@modelcontextprotocol/server'
import type { ZodRawShape } from 'zod'
import { failure, text } from './output.js'

/**
 * Tool presets: expose fewer tools when the client does not need all 185.
 *
 * Motivated by mozilla/firefox-devtools-mcp's --tool-preset, which trims the
 * surface for agents that only browse. Here the preset is picked with
 * DSH_BROWSER_TOOL_PRESET:
 *
 *   slim   read-only tools plus the eighteen page actions almost every task
 *          needs (navigate/click/type/…). ~77 tools.
 *   basic  everything (default) — unchanged behaviour for existing setups.
 *   all    everything.
 *
 * Anything unrecognised falls back to basic, because silently hiding tools is
 * worse than exposing a few more.
 */
const SLIM_WRITES = new Set([
  'browser_navigate',
  'browser_click',
  'browser_click_by_uid',
  'browser_type',
  'browser_fill_by_uid',
  'browser_fill_form',
  'browser_wait_for',
  'browser_press_key',
  'browser_scroll',
  'browser_hover',
  'browser_screenshot',
  'browser_pdf',
  'browser_get_page_text',
  'browser_take_snapshot',
  'browser_new_tab',
  'browser_new_window',
  'browser_close_tab',
  'browser_activate_tab',
])

const PRESET = (process.env.DSH_BROWSER_TOOL_PRESET ?? 'basic').toLowerCase()

export function toolPreset(): string {
  return PRESET === 'slim' ? 'slim' : 'basic'
}

function presetAllows(name: string, annotations: Record<string, unknown>): boolean {
  if (PRESET !== 'slim') return true
  return annotations.readOnlyHint === true || SLIM_WRITES.has(name)
}


/**
 * Register one tool without repeating the same three lines everywhere.
 *
 * Every tool used to be written as:
 *
 *   server.registerTool(name, options, async (args) => {
 *     try { return text(await work(args)) } catch (error) { return failure(error) }
 *   })
 *
 * which is correct but buries the actual behaviour between boilerplate. With
 * this wrapper the handler returns the value directly; the wrapper adds the
 * `text()` envelope and turns thrown errors into a tool error response.
 *
 * Handlers that need a non-text payload (PNG/PDF) return `{ body, kind }`
 * instead of a bare string.
 */
export interface ToolResult {
  body: string
  kind?: 'text' | 'png' | 'pdf'
}

export function defineTool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  options: {
    title: string
    description: string
    inputSchema: S
    annotations: Record<string, unknown>
  },
  handler: (args: Record<string, unknown>) => Promise<string | ToolResult> | string | ToolResult,
): void {
  if (!presetAllows(name, options.annotations)) return
  server.registerTool(
    name as never,
    options as never,
    (async (args: Record<string, unknown>) => {
      try {
        const result = await handler(args ?? {})
        if (typeof result === 'string') return text(result)
        return text(result.body, result.kind ?? 'text')
      } catch (error) {
        return failure(error)
      }
    }) as never,
  )
}
