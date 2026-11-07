import type { BidiClient } from '../bidi/client.js'

/**
 * Map a BiDi context id to the tab index used by the chrome side.
 *
 * MEASURED: these are NOT the same identifier. BiDi hands out an opaque UUID
 * ("e3f9130a-…") while the chrome side's browsingContext.id is a small integer
 * (3), and BrowsingContext.get(uuid) finds nothing. What does line up is ORDER:
 * browsingContext.getTree() and gBrowser.tabs list tabs in the same sequence,
 * so the reliable bridge is the index, not the id.
 */

export async function tabIndexForContext(client: BidiClient, context: string): Promise<number> {
  const tree = (await client.call('browsingContext.getTree', {})) as {
    contexts?: Array<{ context: string }>
  }
  const contexts = tree.contexts ?? []
  const index = contexts.findIndex((item) => item.context === context)
  if (index < 0) throw new Error('no such tab context: ' + context)
  return index
}

/**
 * One response header from the newest network.responseCompleted event for a
 * request.
 *
 * network.getData returns the body bytes as they came off the wire (still
 * gzip/br/deflate compressed), and it carries no headers of its own. The
 * responseCompleted event is the only place to learn the content-encoding, so
 * the body can be unwrapped before it is shown as text.
 */
export function responseHeader(client: BidiClient, requestId: string, name: string): string | null {
  const wanted = name.toLowerCase()
  const events = client.events('network.responseCompleted')
  for (let i = events.length - 1; i >= 0; i--) {
    const params = events[i].params as
      | {
          request?: { request?: string }
          response?: { headers?: Array<{ name?: string; value?: unknown }> }
        }
      | undefined
    if (params?.request?.request !== requestId) continue
    for (const header of params.response?.headers ?? []) {
      if (String(header.name).toLowerCase() !== wanted) continue
      const value = header.value as { value?: unknown } | string | undefined
      if (typeof value === 'string') return value
      if (value !== null && typeof value === 'object' && typeof value.value === 'string') return value.value
    }
  }
  return null
}
