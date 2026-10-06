import { describe, expect, it } from 'vitest'
import { isSensitiveName, splitWords } from '../../src/sensitive.ts'

describe('splitWords', () => {
  it('D16: splits camelCase, PascalCase, snake_case, kebab-case and digits', () => {
    expect(splitWords('passwordHash')).toEqual(['password', 'hash'])
    expect(splitWords('APIKey')).toEqual(['api', 'key'])
    expect(splitWords('tax_id')).toEqual(['tax', 'id'])
    expect(splitWords('home-address')).toEqual(['home', 'address'])
    expect(splitWords('zip5Code')).toEqual(['zip', '5', 'code'])
  })

  it('D16: keeps an acronym with a plural s together and still splits an acronym from a word', () => {
    expect(splitWords('SSNs')).toEqual(['ssns'])
    expect(splitWords('OTPs')).toEqual(['otps'])
    expect(splitWords('taxIDs')).toEqual(['tax', 'ids'])
    expect(splitWords('tax_IDs')).toEqual(['tax', 'ids'])
    expect(splitWords('ZIPCode')).toEqual(['zip', 'code'])
    expect(splitWords('IDNumber')).toEqual(['id', 'number'])
    expect(splitWords('userIPAddress')).toEqual(['user', 'ip', 'address'])
    expect(splitWords('SSNToken')).toEqual(['ssn', 'token'])
    expect(splitWords('SSNId')).toEqual(['ssn', 'id'])
    expect(splitWords('IDsList')).toEqual(['ids', 'list'])
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
    'SSNs',
    'userSSNs',
    'IBANs',
    'OTPs',
    'taxIDs',
    'tax_IDs',
    'hashed',
    'hashedValue',
    'hashed_value',
    'salted',
    'saltedValue',
    'zipcode',
    'ZIPCODE',
    'passcode',
    'PASSCODE',
    'passkey',
    'geolocation',
    'geoip',
    'ipaddr',
    'IPADDR',
    'cardnumber',
    'EMAIL_ADDRESS',
    'API_KEY',
    'PASSWORD_HASH',
    'UserEmail',
    'CreditCardNumber',
    'phone2',
    'cvv2',
    'address2',
    'APIKey',
    'userIP',
    'clientIP',
    'SSNId',
    'userIPId',
    'clientIPId',
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
