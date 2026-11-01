// Mirrors @wechatbot/wechatbot's sender MAX_TEXT_LENGTH (dist/messaging/sender.js).
// The SDK splits any longer text on paragraph / newline / space, which cuts a
// Markdown code fence in half and leaves the rest of the message unrendered.
export const WECHAT_MAX_TEXT_LENGTH = 4_000

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

type Segment =
  | { kind: 'text'; line: string }
  | { kind: 'fence'; open: string; body: string[]; close: string | null }

type Fence = { open: string; body: string[]; close: string | null }

function tokenize(text: string): Segment[] {
  const lines = text.split('\n')
  const segments: Segment[] = []

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN_RE.exec(lines[i])
    if (!open) {
      segments.push({ kind: 'text', line: lines[i] })
      continue
    }

    const marker = open[1]
    const closeIdx = lines.findIndex((line, idx) => {
      if (idx <= i) return false
      const m = FENCE_CLOSE_RE.exec(line)
      return !!m && m[1][0] === marker[0] && m[1].length >= marker.length
    })

    if (closeIdx === -1) {
      // Unterminated in the source: emitted whole it stays exactly as written,
      // split apart it needs a synthesized closing marker.
      segments.push({ kind: 'fence', open: lines[i], body: lines.slice(i + 1), close: null })
      return segments
    }
    segments.push({ kind: 'fence', open: lines[i], body: lines.slice(i + 1, closeIdx), close: lines[closeIdx] })
    i = closeIdx
  }

  return segments
}

function renderFence(fence: Fence): string {
  const lines = [fence.open, ...fence.body]
  if (fence.close !== null) lines.push(fence.close)
  return lines.join('\n')
}

/** Hard cut for a single line that is itself longer than the budget. */
function cutLongLine(line: string, limit: number): string[] {
  const pieces: string[] = []
  for (let i = 0; i < line.length; i += limit) pieces.push(line.slice(i, i + limit))
  return pieces
}

/**
 * Splits an oversized code block so every piece is a complete, renderable
 * fence. The code content is cut at line boundaries; a body line longer than
 * the budget is the only case that gets hard-cut.
 */
function splitFence(fence: Fence, limit: number): string[] {
  const marker = FENCE_OPEN_RE.exec(fence.open)?.[1] ?? '```'
  const closeLen = Math.max(marker.length, fence.close?.length ?? 0)
  const overhead = fence.open.length + 1 + closeLen + 1
  const bodyLimit = Math.max(1, limit - overhead)

  const slices: string[][] = []
  let slice: string[] = []
  let sliceLen = 0
  for (const line of fence.body) {
    if (line.length > bodyLimit) {
      if (slice.length) { slices.push(slice); slice = []; sliceLen = 0 }
      for (const part of cutLongLine(line, bodyLimit)) slices.push([part])
      continue
    }
    const extra = slice.length ? 1 + line.length : line.length
    if (sliceLen + extra > bodyLimit) {
      slices.push(slice)
      slice = [line]
      sliceLen = line.length
    } else {
      slice.push(line)
      sliceLen += extra
    }
  }
  if (slice.length || slices.length === 0) slices.push(slice)

  return slices.map((part, idx) =>
    renderFence({ open: fence.open, body: part, close: idx === slices.length - 1 ? fence.close ?? marker : marker }))
}

/**
 * Split Markdown into pieces no longer than `limit`, never breaking inside a
 * ``` or ~~~ code fence. Segments are packed greedily; a fence travels as one
 * unit and is re-opened (with its original info line) when it must be split.
 */
export function chunkMarkdown(text: string, limit: number = WECHAT_MAX_TEXT_LENGTH): string[] {
  if (limit <= 0) throw new Error('limit must be a positive integer')
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let current: string[] = []
  let currentLen = 0

  const append = (piece: string) => {
    currentLen += (current.length ? 1 : 0) + piece.length
    current.push(piece)
  }
  const flush = () => {
    if (current.length) chunks.push(current.join('\n'))
    current = []
    currentLen = 0
  }

  for (const segment of tokenize(text)) {
    if (segment.kind === 'fence') {
      const rendered = renderFence(segment)
      if (rendered.length <= limit) {
        if (currentLen + (current.length ? 1 : 0) + rendered.length > limit) flush()
        append(rendered)
        continue
      }
      flush()
      const pieces = splitFence(segment, limit)
      for (let i = 0; i < pieces.length - 1; i++) chunks.push(pieces[i])
      current = [pieces[pieces.length - 1]]
      currentLen = current[0].length
      continue
    }

    if (segment.line.length <= limit) {
      if (currentLen + (current.length ? 1 : 0) + segment.line.length > limit) flush()
      append(segment.line)
      continue
    }
    flush()
    const pieces = cutLongLine(segment.line, limit)
    for (let i = 0; i < pieces.length - 1; i++) chunks.push(pieces[i])
    append(pieces[pieces.length - 1])
  }

  flush()
  return chunks.length ? chunks : ['']
}
