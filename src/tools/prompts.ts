import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { READ_ONLY, WRITES } from '../support/annotations.js'
import { defineTool } from '../support/define-tool.js'
import { withBidi } from '../support/connection.js'
import { text } from '../support/output.js'
import { str } from '../support/strings.js'

/**
 * Page prompts (alert/confirm/prompt) and history traversal.
 */
export function registerPrompts(server: McpServer): void {
  defineTool(
    server,
    'browser_traverse_history',
    {
      title: 'Go back or forward',
      description:
        'Move the active tab through its session history (browsingContext.traverseHistory): delta -1 is back, +1 is ' +
        'forward. Fails with "no such history entry" when that direction has nothing to go to, which is a normal ' +
        'answer rather than a broken tool.',
      inputSchema: {
        delta: z.number().int().describe('Negative goes back, positive goes forward (e.g. -1 or 1)'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ delta, context }: { delta: number; context?: string }) =>
      await withBidi(async (client) => {
        let target = context === undefined ? null : str(context, 'context')
        if (target === null) target = await client.pageContext()
        if (target === null) throw new Error('no active tab')
        try {
          await client.call('browsingContext.traverseHistory', { context: target, delta })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/no such history entry/i.test(message)) {
            return 'no history entry in that direction (delta ' + String(delta) + ')'
          }
          throw error
        }
        return 'traversed history by ' + String(delta)
      }),
  )

  defineTool(
    server,
    'browser_list_prompts',
    {
      title: 'Alerts and prompts seen so far',
      description:
        'List page prompts (alert / confirm / prompt / beforeunload) that opened since this server connected, as ' +
        'reported by BiDi browsingContext.userPromptOpened, newest first. A page that shows one of these blocks its ' +
        'script until it is answered — use browser_handle_prompt to accept or dismiss. If a page seems stuck, check ' +
        'here first.',
      inputSchema: { limit: z.number().int().positive().max(50).optional().describe('Max entries (default 10)') },
      annotations: READ_ONLY,
    },
    async ({ limit }: { limit?: number }) => {
      const events = await withBidi(async (client) => client.events('browsingContext.userPromptOpened'))
      if (events.length === 0) return 'no page prompts observed since this server connected'
      const newest = events.slice(-(limit ?? 10)).reverse()
      return JSON.stringify(newest, null, 2)
    },
  )

  defineTool(
    server,
    'browser_handle_prompt',
    {
      title: 'Accept or dismiss a page prompt',
      description:
        'Answer the alert / confirm / prompt that a page is waiting on (BiDi browsingContext.handleUserPrompt). ' +
        'accept: true clicks OK, false cancels. userText supplies the answer for a prompt() dialog. Without this the ' +
        'page stays blocked; "no such alert" means nothing is waiting, which is a normal answer.',
      inputSchema: {
        accept: z.boolean().describe('true = OK, false = Cancel'),
        userText: z.string().optional().describe('Text to enter for a prompt() dialog'),
        context: z.string().optional().describe('Tab context id (default: the active tab)'),
      },
      annotations: WRITES,
    },
    async ({ accept, userText, context }: { accept: boolean; userText?: string; context?: string }) =>
      await withBidi(async (client) => {
        let target = context === undefined ? null : str(context, 'context')
        if (target === null) target = await client.pageContext()
        if (target === null) throw new Error('no active tab')
        const params: Record<string, unknown> = { context: target, accept }
        if (userText !== undefined) params.userText = userText
        try {
          await client.call('browsingContext.handleUserPrompt', params)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/no such alert/i.test(message)) {
            return 'no prompt is waiting on that tab'
          }
          throw error
        }
        return (accept ? 'accepted' : 'dismissed') + ' the prompt' + (userText === undefined ? '' : ' with text')
      }),
  )
}
