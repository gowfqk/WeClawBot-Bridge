import { describe, expect, it } from 'vitest'
import { WECHAT_MAX_TEXT_LENGTH, chunkMarkdown } from './markdown-chunk'

const fenceLines = (text: string) =>
  text.split('\n').filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line)).length

function assertValid(chunks: string[], limit: number) {
  for (const chunk of chunks) {
    expect(chunk.length, `chunk over limit: ${chunk.length}\n---\n${chunk}\n---`).toBeLessThanOrEqual(limit)
    expect(fenceLines(chunk) % 2, `unbalanced fence:\n${chunk}`).toBe(0)
  }
}

describe('chunkMarkdown', () => {
  it('leaves text inside the budget untouched', () => {
    const text = '第一行\n第二行'
    expect(chunkMarkdown(text, 100)).toEqual([text])
    expect(chunkMarkdown(text)).toEqual([text])
  })

  it('does not modify the SDK budget default', () => {
    expect(WECHAT_MAX_TEXT_LENGTH).toBe(4_000)
  })

  it('splits plain text on line boundaries and round-trips exactly', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const chunks = chunkMarkdown(text, 60)
    assertValid(chunks, 60)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n')).toBe(text)
  })

  it('keeps a code fence whole even when it crosses the boundary', () => {
    const filler = '说明段落。\n'.repeat(6)
    const code = 'function a() {\n  return 1\n}\n'
    const text = `${filler}示例：\n\`\`\`js\n${code}\`\`\`\n结尾。`
    const chunks = chunkMarkdown(text, 40)

    assertValid(chunks, 40)
    const whole = ['```js', 'function a() {', '  return 1', '}', '```'].join('\n')
    expect(chunks.some((chunk) => chunk.includes(whole))).toBe(true)
    expect(chunks.join('\n')).toBe(text)
  })

  it('reopens the fence with its info line when a single block is oversized', () => {
    const body = Array.from({ length: 30 }, (_, i) => `const x${i} = ${i}`).join('\n')
    const text = `\`\`\`ts\n${body}\n\`\`\``
    const chunks = chunkMarkdown(text, 60)

    assertValid(chunks, 60)
    for (const chunk of chunks) expect(chunk.startsWith('```ts\n')).toBe(true)
    expect(chunks[chunks.length - 1].endsWith('```')).toBe(true)
    const recovered = chunks.map((chunk) => chunk.split('\n').slice(1, -1).join('\n'))
      .filter(Boolean)
      .join('\n')
    expect(recovered).toBe(body)
  })

  it('treats tilde fences as code blocks too', () => {
    const body = Array.from({ length: 30 }, (_, i) => `a${i}`).join('\n')
    const text = `前言\n~~~\n${body}\n~~~`
    const chunks = chunkMarkdown(text, 50)

    assertValid(chunks, 50)
    expect(chunks[0]).toBe('前言')
    const code = chunks.flatMap((chunk) => chunk.split('\n').filter((line) => /^a\d+$/.test(line)))
    expect(code.join('\n')).toBe(body)
  })

  it('closes an unterminated fence when it has to be split', () => {
    const body = Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\n')
    const chunks = chunkMarkdown(`\`\`\`python\n${body}`, 50)
    assertValid(chunks, 50)
    expect(chunks[0].startsWith('```python\n')).toBe(true)
    const last = chunks[chunks.length - 1]
    expect(last.startsWith('```python\n')).toBe(true)
    expect(last.endsWith('```')).toBe(true)
    const rows = chunks.flatMap((chunk) => chunk.split('\n').filter((line) => /^row \d+$/.test(line)))
    expect(rows.join('\n')).toBe(body)
  })

  it('hard-cuts a single line that is longer than the budget', () => {
    const text = 'x'.repeat(125)
    const chunks = chunkMarkdown(text, 50)
    assertValid(chunks, 50)
    expect(chunks.join('')).toBe(text)
  })

  it('never loses content when the fences all fit their chunks', () => {
    const lines = [
      ...Array.from({ length: 8 }, (_, i) => `段落一 第${i}行`),
      '```bash',
      'npm run build',
      'npm run test',
      '```',
      ...Array.from({ length: 8 }, (_, i) => `段落二 第${i}行`),
      '```',
      'echo done',
      '```',
    ]
    const text = lines.join('\n')
    const chunks = chunkMarkdown(text, 40)

    assertValid(chunks, 40)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n')).toBe(text)
  })

  it('rejects a non-positive limit', () => {
    expect(() => chunkMarkdown('abc', 0)).toThrow(/positive/)
  })
})
