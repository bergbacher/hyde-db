import { describe, expect, it } from 'vitest'
import { isSensitiveName } from '../../src/sensitive.ts'

describe('sensitive-name lint (base pattern)', () => {
  it.each([
    'password',
    'passwordHash',
    'secret',
    'accessToken',
    'api_key',
    'apiKey',
    'email',
    'e_mail',
    'phone',
    'mobile',
    'iban',
    'cardNumber',
    'cvv',
    'ssn',
    'tax_id',
    'taxId',
    'passport',
    'birthDate',
    'dob',
    'address',
    'street',
    'zip',
    'postal_code',
    'ip_addr',
    'ip',
    'geo',
    'latitude',
    'lng',
    'longitude',
    'salary',
    'note',
    'comment',
    'otp',
    'mfa',
    'totp',
    'salt',
  ])('flags %s', (name) => {
    expect(isSensitiveName(name)).toBe(true)
  })

  it.each(['title', 'country', 'plan', 'createdAt', 'status', 'total_cents', 'placedAt'])(
    'does not flag %s',
    (name) => {
      expect(isSensitiveName(name)).toBe(false)
    },
  )

  it.each(['isPrivate', 'footprint', 'passenger', 'discarded', 'flat'])(
    'A5: the base pattern matches inside the unrelated name %s',
    (name) => {
      expect(isSensitiveName(name)).toBe(true)
    },
  )
})
