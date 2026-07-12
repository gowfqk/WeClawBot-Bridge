import { describe, expect, it, vi } from 'vitest'

describe('logger transport selection', () => {
  it('uses pino-pretty only in development', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    vi.resetModules()
    const development = await import('./logger')
    expect(development.getLoggerOptions().transport).toEqual({
      target: 'pino-pretty',
      options: { colorize: true },
    })

    process.env.NODE_ENV = 'production'
    vi.resetModules()
    const production = await import('./logger')
    expect(production.getLoggerOptions().transport).toBeUndefined()

    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  })

  it('does not require pino-pretty when NODE_ENV is unset', async () => {
    const previous = process.env.NODE_ENV
    delete process.env.NODE_ENV
    vi.resetModules()
    const loggerModule = await import('./logger')
    expect(loggerModule.getLoggerOptions().transport).toBeUndefined()

    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  })
})
