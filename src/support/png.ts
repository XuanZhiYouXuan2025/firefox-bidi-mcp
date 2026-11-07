import { inflateSync } from 'node:zlib'

/**
 * Minimal PNG decoder for BiDi screenshots: 8-bit, non-interlaced, colour type 0/2/6.
 * Returns straight (non-premultiplied) RGBA.
 */
export function decodePng(base64: string): { width: number; height: number; rgba: Uint8Array } {
  const b64 = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64
  const buf = Buffer.from(b64, 'base64')
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a PNG')
  let off = 8
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0
  const idat: Buffer[] = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8) throw new Error('unsupported PNG bit depth ' + String(bitDepth))
  if (interlace !== 0) throw new Error('interlaced PNG is not supported')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (channels === 0) throw new Error('unsupported PNG colour type ' + String(colorType))
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) line[x] = raw[pos + x]
    pos += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a),
          pb = Math.abs(pp - b),
          pc = Math.abs(pp - c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        v = (v + pr) & 0xff
      }
      line[x] = v
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels
      const di = (y * width + x) * 4
      out[di] = line[si]
      out[di + 1] = channels >= 3 ? line[si + 1] : line[si]
      out[di + 2] = channels >= 3 ? line[si + 2] : line[si]
      out[di + 3] = channels === 4 ? line[si + 3] : 255
    }
    prev = line
  }
  return { width, height, rgba: out }
}
