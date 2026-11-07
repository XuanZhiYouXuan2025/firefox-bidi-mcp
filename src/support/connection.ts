import { BidiClient } from '../bidi/client.js'
import { MarionetteClient, marionettePort } from '../bidi/marionette.js'
import { port } from './port.js'

/**
 * One shared BiDi session for the whole server process.
 *
 * Firefox allows a SINGLE active BiDi session ("Maximum number of active
 * sessions"), so opening a session per tool call makes concurrent calls fail
 * unpredictably. BiDi is JSON-RPC over a WebSocket and matches responses by id,
 * so several in-flight commands can share one connection safely.
 *
 * The connection is opened lazily and re-opened once if it turns out to be
 * dead, so a Firefox restart does not require restarting this server.
 */
let shared: BidiClient | null = null

let connecting: Promise<BidiClient> | null = null

/** The live client, if one has been opened. Used by the exit handler. */
export function currentClient(): BidiClient | null {
  return shared
}

export async function getClient(): Promise<BidiClient> {
  if (shared !== null) return shared
  if (connecting === null) {
    connecting = (async () => {
      const client = new BidiClient()
      await client.connect(port)
      // Subscribe once per connection so download events accumulate even when
      // no tool call is in flight.
      try {
        await client.subscribe(OBSERVED_EVENTS)
      } catch {
        // An older Firefox may not know these events; the tools still work.
      }
      shared = client
      return client
    })()
  }
  try {
    return await connecting
  } finally {
    connecting = null
  }
}

/** Run `body` against the shared session, reconnecting once if it has died. */
export async function withBidi<T>(body: (client: BidiClient) => Promise<T>): Promise<T> {
  try {
    return await body(await getClient())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const looksLikeDeath = shared !== null && /not connected|closed|EPIPE|ECONNRESET|socket/i.test(message)
    if (!looksLikeDeath) throw error
    await shared?.close()
    shared = null
    return await body(await getClient())
  }
}

/**
 * End the session on the way out.
 *
 * BiDi does NOT release a session when the socket closes, and a leftover
 * session makes the NEXT start fail with "Maximum number of active sessions"
 * — which cannot be cleared from the protocol side (a `session.end` without an
 * id answers "invalid session id"), only by restarting Firefox. So cleanup is
 * best-effort on every exit path that can still run async code.
 */
export async function shutdown(): Promise<void> {
  const client = shared
  shared = null
  connecting = null
  if (client !== null) await client.close()
}

/**
 * Cap on how much one tool may return.
 *
 * `browser_evaluate` and `browser_screenshot` can return arbitrarily large
 * payloads (a 12 MB string was measured), which would swamp the model's
 * context. Long results are truncated with a note saying how much was cut,
 * so a caller can narrow the expression and ask again.
 */
export const OBSERVED_EVENTS = [
  'browsingContext.downloadWillBegin',
  'browsingContext.downloadEnd',
  'log.entryAdded',
  'network.beforeRequestSent',
  'network.responseCompleted',
  'network.responseStarted',
  'network.fetchError',
  'browsingContext.userPromptOpened',
  'browsingContext.screencastFrame',
]

/**
 * Where oversized results are written. Defaults to the system temp dir; set
 * DSH_BROWSER_OUTPUT_DIR to keep them somewhere you can find later.
 */
/**
 * Open a short-lived Marionette session, run `body`, always close.
 *
 * Retried once on purpose: MEASURED, the FIRST connection after an earlier
 * session was torn down can be rejected ("[object Object]"), while every later
 * attempt succeeds. Ending the session properly (see MarionetteClient.end) plus
 * one retry makes GPC reliable instead of a coin flip.
 */
export async function withMarionette<T>(body: (client: MarionetteClient) => Promise<T>): Promise<T> {
  let lastError: unknown = new Error('marionette: no attempt was made')
  for (let attempt = 0; attempt < 2; attempt++) {
    let client: MarionetteClient | null = null
    try {
      client = await MarionetteClient.connect(marionettePort())
      await client.startChromeSession()
      return await body(client)
    } catch (error) {
      lastError = error
    } finally {
      await client?.end().catch(() => undefined)
    }
  }
  throw lastError
}

export async function withPage<T>(body: (client: BidiClient, context: string) => Promise<T>, tab?: string): Promise<T> {
  return await withBidi(async (client) => {
    // 2026-10-31: an explicit tab context beats the active tab, so callers can
    // pin their own window and never touch whatever tab the user has in front.
    const context = tab !== undefined && tab !== '' ? tab : await client.pageContext()
    if (context === null) throw new Error('no page context available')
    return await body(client, context)
  })
}

export async function withChrome<T>(body: (client: BidiClient, context: string) => Promise<T>): Promise<T> {
  return await withBidi(async (client) => {
    const context = await client.chromeContext()
    if (context === null) {
      throw new Error('no privileged (chrome) context — Firefox must be launched with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1')
    }
    return await body(client, context)
  })
}
