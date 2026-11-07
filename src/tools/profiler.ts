import type { McpServer } from '@modelcontextprotocol/server'
import { join } from 'node:path'
import { z } from 'zod'
import { READ_ONLY, WRITES } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withChrome } from '../support/connection.js'
import { outputDir } from '../support/output.js'

/**
 * Firefox performance profiler (chrome context).
 *
 * MEASURED on Firefox 160.0: Services.profiler is present and exposes
 * StartProfiler / StopProfiler / getElapsedTime / GetBufferInfo /
 * getProfileDataAsync / dumpProfileToFileAsync / GetFeatures / sharedLibraries.
 * The profile is the standard Firefox Profiler JSON, so it opens directly in
 * profiler.firefox.com.
 *
 * This tool deliberately stays small: start, status, stop. Analysis (hot
 * functions, jank, GC) belongs to profiler.firefox.com or profiler-cli — do not
 * grow a second profiler here.
 */
export function registerProfiler(server: McpServer): void {
  defineTool(
    server,
    'browser_profiler',
    {
      title: 'Firefox performance profiler',
      description:
        'Record a performance profile with Services.profiler (chrome context). action:"start" begins sampling, ' +
        'action:"status" reports whether it is running plus elapsed time and buffer info, action:"stop" writes the ' +
        'standard Firefox Profiler JSON to disk and returns the path. Open that file at profiler.firefox.com or feed ' +
        'it to profiler-cli. The profile grows with the work being measured, so keep recordings short.',
      inputSchema: {
        action: z.enum(['start', 'status', 'stop']).describe('start / status / stop'),
        path: z
          .string()
          .optional()
          .describe('Where stop writes the profile (absolute path). Default: DSH_BROWSER_OUTPUT_DIR/firefox-profile-<ts>.json'),
      },
      annotations: WRITES,
    },
    async ({ action, path }: { action?: string; path?: string }) => {
      const what = action ?? 'status'
      if (what === 'start') {
        return await withChrome(async (client, ctx) => {
          const active = await client.evaluate('Services.profiler.IsActive()', ctx)
          if (active === true) throw new Error('the profiler is already running — stop it first')
          await client.evaluate('Services.profiler.StartProfiler(1000, 1, [], [], 0, 0)', ctx)
          return 'profiler started; do the work you want measured, then call { action: "stop" }'
        })
      }
      if (what === 'status') {
        return await withChrome(async (client, ctx) => {
          const raw = await client.evaluate(
            'JSON.stringify({' +
              ' active: Services.profiler.IsActive(),' +
              ' paused: Services.profiler.IsPaused(),' +
              ' elapsedMs: Services.profiler.getElapsedTime()' +
              '})',
            ctx,
          )
          return String(raw)
        })
      }
      const target = path ?? join(outputDir, 'firefox-profile-' + Date.now() + '.json')
      return await withChrome(async (client, ctx) => {
        const active = await client.evaluate('Services.profiler.IsActive()', ctx)
        if (active !== true) throw new Error('the profiler is not running — call { action: "start" } first')
        const saved = await client.evaluate(
          '(async () => {' +
            ' await Services.profiler.dumpProfileToFileAsync(' + JSON.stringify(target) + ');' +
            ' return ' + JSON.stringify(target) + ';' +
            '})()',
          ctx,
        )
        return 'profile saved: ' + String(saved) + ' (open it at profiler.firefox.com)'
      })
    },
  )
}
