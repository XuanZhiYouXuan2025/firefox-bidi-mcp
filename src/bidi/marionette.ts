/**
 * Minimal Marionette client — only for the handful of commands that do not
 * exist on the BiDi side (Global Privacy Control, and a few others).
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything else in this server speaks BiDi. Two capabilities only exist in
 * Marionette: GPC (GPC:Get/SetGlobalPrivacyControl). Rather than abandon them,
 * this module opens a *second, short-lived* connection to Marionette's port
 * (default 2828, started with --marionette) for exactly those calls.
 *
 * THE PACKET FORMAT IS THE WHOLE TRAP
 * -----------------------------------
 * Measured: Marionette's server calls `if (!Array.isArray(data)) { return }`
 * on every packet. A packet is a JSON ARRAY:
 *
 *     [0, <id>, "<CommandName>", {<params>}]
 *
 * Sending a JSON OBJECT instead is rejected *without any reply at all*, which
 * looks exactly like "the command hangs". That cost a long detour — hence this
 * comment.
 *
 * The wire framing is `<byteLength>:<json>` both ways.
 */

import { Socket } from 'node:net'

/** One Marionette command/reply pair. */
interface MarionetteReply {
  id?: number
  error?: string
  message?: string
  /** Replies carry their payload at index 3 as an object. */
  payload?: Record<string, unknown>
}

export class MarionetteClient {
  readonly #socket: Socket
  #buffer: Buffer
  #nextId: number
  #closed: boolean

  private constructor(socket: Socket) {
    this.#socket = socket
    this.#buffer = Buffer.alloc(0)
    this.#nextId = 1
    this.#closed = false
  }

  /** Connect, and consume the greeting the server sends immediately. */
  static async connect(port: number, timeoutMs = 10000): Promise<MarionetteClient> {
    const socket = new Socket()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('marionette connect timed out on port ' + String(port)))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.connect(port, '127.0.0.1')
    })
    socket.setNoDelay(true)
    const client = new MarionetteClient(socket)
    // The server greets with {"applicationType":"gecko","marionetteProtocol":3}.
    await client.#readPacket(timeoutMs)
    return client
  }

  /** Read exactly one `<len>:<json>` packet. */
  #readPacket(timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const tryParse = (): unknown | undefined => {
        const colon = this.#buffer.indexOf(0x3a) // ':'
        if (colon < 0) return undefined
        const length = Number.parseInt(this.#buffer.subarray(0, colon).toString('ascii'), 10)
        if (!Number.isFinite(length) || length < 0) {
          reject(new Error('marionette gave a bad packet length'))
          return undefined
        }
        const bodyStart = colon + 1
        if (this.#buffer.length < bodyStart + length) return undefined
        const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
        this.#buffer = this.#buffer.subarray(bodyStart + length)
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
        return undefined
      }
      const onData = (chunk: Buffer): void => {
        this.#buffer = Buffer.concat([this.#buffer, chunk])
        if (tryParse() === undefined && Date.now() - started > timeoutMs) {
          cleanup()
          reject(new Error('marionette reply timed out after ' + String(timeoutMs) + 'ms'))
        }
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onClose = (): void => {
        cleanup()
        reject(new Error('marionette connection closed'))
      }
      const timer = setInterval(() => {
        if (Date.now() - started > timeoutMs) {
          cleanup()
          reject(new Error('marionette reply timed out after ' + String(timeoutMs) + 'ms'))
        }
      }, 200)
      const cleanup = (): void => {
        clearInterval(timer)
        this.#socket.off('data', onData)
        this.#socket.off('error', onError)
        this.#socket.off('close', onClose)
      }
      this.#socket.on('data', onData)
      this.#socket.on('error', onError)
      this.#socket.on('close', onClose)
      // A packet may already be buffered.
      if (tryParse() !== undefined) {
        cleanup()
      }
    })
  }

  /**
   * Send one command and return its reply payload.
   *
   * `name` is e.g. "WebDriver:NewSession" or "GPC:GetGlobalPrivacyControl".
   */
  async command(
    name: string,
    params: Record<string, unknown> = {},
    timeoutMs = 20000,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) throw new Error('marionette client is closed')
    const id = this.#nextId++
    const packet = JSON.stringify([0, id, name, params])
    this.#socket.write(String(Buffer.byteLength(packet, 'utf8')) + ':' + packet, 'utf8')
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('marionette command timed out: ' + name)
      const reply = (await this.#readPacket(remaining)) as MarionetteReply | unknown[]
      if (!Array.isArray(reply)) continue // greeting or unrelated
      if (reply[1] !== id) continue // not ours; keep reading
      const payload = (reply[3] ?? {}) as Record<string, unknown>
      if (reply[2] !== null && reply[2] !== undefined) {
        // MEASURED: reply[2] is normally a string ("session not created"), but a
        // rejected session can carry an object there. String(object) would turn
        // the whole diagnostic into "[object Object]", which is exactly the
        // unhelpful message this client used to surface.
        const error =
          typeof reply[2] === 'string'
            ? reply[2]
            : (() => {
                try {
                  return JSON.stringify(reply[2])
                } catch {
                  return String(reply[2])
                }
              })()
        const rawMessage = (payload as { message?: unknown }).message
        const message =
          rawMessage === undefined
            ? ''
            : typeof rawMessage === 'string'
              ? rawMessage
              : (() => {
                  try {
                    return JSON.stringify(rawMessage)
                  } catch {
                    return String(rawMessage)
                  }
                })()
        throw new Error(error + (message === '' ? '' : ': ' + message))
      }
      return payload
    }
  }

  /** Open a session and switch to the privileged context; returns nothing. */
  async startChromeSession(): Promise<void> {
    await this.command('WebDriver:NewSession')
    await this.command('Marionette:SetContext', { value: 'chrome' })
  }

  /**
   * End the WebDriver session, then close the socket.
   *
   * MEASURED: destroying the socket alone leaves the Marionette session behind
   * on the Firefox side, and the NEXT connection then fails intermittently with
   * a rejection whose text reads "[object Object]". A best-effort
   * WebDriver:DeleteSession before the close keeps the next call clean.
   */
  async end(): Promise<void> {
    if (this.#closed) return
    try {
      await this.command('WebDriver:DeleteSession', {}, 3000)
    } catch {
      // Best effort: closing still has to happen.
    }
    this.close()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#socket.destroy()
    } catch {
      // Ignore: closing is best effort.
    }
  }
}

/** Marionette port from the environment, defaulting to Firefox's 2828. */
export function marionettePort(): number {
  const raw = process.env.DSH_BROWSER_MARIONETTE_PORT
  if (raw === undefined) return 2828
  const value = Number.parseInt(raw, 10)
  return Number.isInteger(value) && value > 0 ? value : 2828
}
