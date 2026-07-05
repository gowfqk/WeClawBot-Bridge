import { describe, it, expect } from 'vitest'
import { validate, LoginSchema, SetupSchema, ChangePasswordSchema, AgentConfigSchema } from './schemas'

describe('Schemas', () => {
  describe('LoginSchema', () => {
    it('rejects empty password', () => {
      const r = validate(LoginSchema, {})
      expect(r.ok).toBe(false)
    })

    it('accepts non-empty password', () => {
      const r = validate(LoginSchema, { password: 'secret' })
      expect(r.ok).toBe(true)
    })
  })

  describe('SetupSchema', () => {
    it('rejects short password', () => {
      const r = validate(SetupSchema, { password: 'ab' })
      expect(r.ok).toBe(false)
    })

    it('accepts valid password', () => {
      const r = validate(SetupSchema, { password: 'longenough' })
      expect(r.ok).toBe(true)
    })
  })

  describe('ChangePasswordSchema', () => {
    it('rejects missing oldPassword', () => {
      const r = validate(ChangePasswordSchema, { newPassword: 'newpass' })
      expect(r.ok).toBe(false)
    })

    it('accepts valid input', () => {
      const r = validate(ChangePasswordSchema, { oldPassword: 'old', newPassword: 'new1' })
      expect(r.ok).toBe(true)
    })
  })

  describe('AgentConfigSchema', () => {
    it('rejects missing required fields', () => {
      const r = validate(AgentConfigSchema, { id: 'test' })
      expect(r.ok).toBe(false)
    })

    it('accepts valid agent config', () => {
      const r = validate(AgentConfigSchema, {
        id: 'test',
        name: 'Test Agent',
        command: 'test',
        type: 'http',
        description: 'A test agent',
        timeout: 30000,
      })
      expect(r.ok).toBe(true)
    })

    it('rejects invalid type', () => {
      const r = validate(AgentConfigSchema, {
        id: 'test',
        name: 'Test',
        command: 'test',
        type: 'invalid',
      })
      expect(r.ok).toBe(false)
    })
  })
})
