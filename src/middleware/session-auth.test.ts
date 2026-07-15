import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryStorage } from '../storage'
import { SessionAuth } from '../middleware/session-auth'

describe('SessionAuth', () => {
  let storage: MemoryStorage
  let auth: SessionAuth

  beforeEach(() => {
    storage = new MemoryStorage()
    auth = new SessionAuth(storage, '')
  })

  describe('isPasswordSet', () => {
    it('returns false when no password is set', async () => {
      expect(await auth.isPasswordSet()).toBe(false)
    })

    it('returns true when envApiKey is set', async () => {
      const authWithEnv = new SessionAuth(storage, 'env-secret')
      expect(await authWithEnv.isPasswordSet()).toBe(true)
    })

    it('returns true after setPassword', async () => {
      await auth.setPassword('mypassword')
      expect(await auth.isPasswordSet()).toBe(true)
    })
  })

  describe('verifyPassword', () => {
    it('rejects wrong password', async () => {
      await auth.setPassword('correct')
      expect(await auth.verifyPassword('wrong')).toBe(false)
    })

    it('accepts correct password', async () => {
      await auth.setPassword('correct')
      expect(await auth.verifyPassword('correct')).toBe(true)
    })

    it('accepts env var password with timing-safe comparison', async () => {
      const authWithEnv = new SessionAuth(storage, 'env-secret')
      expect(await authWithEnv.verifyPassword('env-secret')).toBe(true)
      expect(await authWithEnv.verifyPassword('wrong')).toBe(false)
    })
  })

  describe('login', () => {
    it('returns null for wrong password', async () => {
      await auth.setPassword('pass')
      expect(await auth.login('wrong')).toBeNull()
    })

    it('returns session for correct password', async () => {
      await auth.setPassword('pass')
      const session = await auth.login('pass')
      expect(session).not.toBeNull()
      expect(session!.token).toBeTruthy()
      expect(session!.expiresAt).toBeGreaterThan(Date.now())
    })
  })

  describe('validateToken', () => {
    it('rejects unknown token', async () => {
      await auth.setPassword('pass')
      await auth.login('pass')
      expect(auth.validateToken('unknown-token')).toEqual({ valid: false, expired: false })
    })

    it('accepts valid token', async () => {
      await auth.setPassword('pass')
      const session = await auth.login('pass')
      expect(auth.validateToken(session!.token)).toEqual({ valid: true, expired: false })
    })
  })

  describe('logout', () => {
    it('invalidates specific token', async () => {
      await auth.setPassword('pass')
      const s1 = await auth.login('pass')
      const s2 = await auth.login('pass')
      auth.logout(s1!.token)
      expect(auth.validateToken(s1!.token).valid).toBe(false)
      expect(auth.validateToken(s2!.token).valid).toBe(true)
    })
  })

  describe('changePassword', () => {
    it('fails with wrong old password', async () => {
      await auth.setPassword('old')
      expect(await auth.changePassword('wrong', 'new')).toBe(false)
    })

    it('succeeds with correct old password', async () => {
      await auth.setPassword('old')
      expect(await auth.changePassword('old', 'new')).toBe(true)
      expect(await auth.verifyPassword('new')).toBe(true)
      expect(await auth.verifyPassword('old')).toBe(false)
    })
  })
})
