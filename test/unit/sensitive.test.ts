import { describe, expect, it } from 'vitest'
import { isSensitiveName, splitWords } from '../../src/sensitive.ts'

describe('splitWords', () => {
  it('splits camelCase, PascalCase, snake_case, kebab-case and digits', () => {
    expect(splitWords('passwordHash')).toEqual(['password', 'hash'])
    expect(splitWords('APIKey')).toEqual(['api', 'key'])
    expect(splitWords('tax_id')).toEqual(['tax', 'id'])
    expect(splitWords('home-address')).toEqual(['home', 'address'])
    expect(splitWords('zip5Code')).toEqual(['zip', '5', 'code'])
  })
})

describe('sensitive-name lint', () => {
  it.each([
    'password',
    'passwordHash',
    'password_hash',
    'passwd',
    'passphrase',
    'secret',
    'accessToken',
    'api_key',
    'apiKey',
    'userApiKeys',
    'email',
    'e_mail',
    'eMail',
    'supportEmail',
    'phoneNumber',
    'mobile',
    'mobileNumber',
    'iban',
    'bic',
    'cardNumber',
    'creditCard',
    'cvv',
    'ssn',
    'taxId',
    'tax_id',
    'taxIds',
    'taxid',
    'vat',
    'vatNumber',
    'passport',
    'birthDate',
    'dateOfBirth',
    'dob',
    'homeAddress',
    'street',
    'zip',
    'zipCode',
    'postalCode',
    'ipAddr',
    'clientIp',
    'ip',
    'geo',
    'geoPoint',
    'lat',
    'latitude',
    'lng',
    'lon',
    'longitude',
    'salary',
    'note',
    'notes',
    'adminNote',
    'comment',
    'comments',
    'otp',
    'otpSecret',
    'mfa',
    'totp',
    'hash',
    'hashes',
    'salt',
    'pass',
    'passCode',
  ])('D16: flags %s', (name) => {
    expect(isSensitiveName(name)).toBe(true)
  })

  it.each(['isPrivate', 'footprint', 'passenger', 'discarded', 'flat'])(
    'D16: no longer flags %s, a base false positive (A5)',
    (name) => {
      expect(isSensitiveName(name)).toBe(false)
    },
  )

  it.each([
    'bicycle',
    'automobile',
    'notebook',
    'longName',
    'cardinality',
    'hashtag',
    'basalt',
    'title',
    'country',
    'plan',
    'createdAt',
    'status',
    'total_cents',
    'syntaxIdentifier',
    'geometry',
    'placedAt',
    'categoryId',
  ])('D16: does not flag %s (short terms match whole words only)', (name) => {
    expect(isSensitiveName(name)).toBe(false)
  })

  it('D16: accepted trade-off — an all-lowercase run-together name misses short terms', () => {
    expect(isSensitiveName('billingzip')).toBe(false)
    expect(isSensitiveName('billingZip')).toBe(true)
  })
})
