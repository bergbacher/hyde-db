// Sensitive-name lint (D16). Names are split into words. Long, unambiguous stems match
// anywhere; short terms match whole words only, plurals included. Accepted trade-off: an
// all-lowercase run-together name like `billingzip` misses short terms.

/** Match anywhere in the name once separators and case are removed. */
const LONG_STEMS: readonly string[] = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'email',
  'phone',
  'passport',
  'birth',
  'address',
  'street',
  'postal',
  'salary',
  'comment',
  'latitude',
  'longitude',
  'zipcode',
  'postcode',
  'passcode',
  'passkey',
  'geolocation',
  'geoip',
  'ipaddr',
  'cardnumber',
]

/**
 * Match whole words; multi-word terms match consecutive words. A plural `s`/`es` is allowed on
 * the last word of the term, wherever the term sits in the name.
 */
const SHORT_TERMS: readonly (readonly string[])[] = [
  ['pass'],
  ['hash'],
  ['hashed'],
  ['salt'],
  ['salted'],
  ['otp'],
  ['mfa'],
  ['totp'],
  ['mobile'],
  ['iban'],
  ['bic'],
  ['card'],
  ['cvv'],
  ['ssn'],
  ['tax', 'id'],
  ['taxid'],
  ['vat'],
  ['dob'],
  ['zip'],
  ['ip'],
  ['geo'],
  ['lat'],
  ['lng'],
  ['lon'],
  ['note'],
]

/** Splits camelCase, PascalCase, snake_case, kebab-case and digit boundaries into lowercase words. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z]{2,})/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase())
}

function isWordOrPlural(word: string | undefined, term: string): boolean {
  return word === term || word === `${term}s` || word === `${term}es`
}

function containsTerm(words: readonly string[], term: readonly string[]): boolean {
  const last = term.length - 1
  for (let start = 0; start + term.length <= words.length; start++) {
    const window = words.slice(start, start + term.length)
    if (
      term.every((part, i) => (i === last ? isWordOrPlural(window[i], part) : window[i] === part))
    ) {
      return true
    }
  }
  return false
}

export function isSensitiveName(name: string): boolean {
  const words = splitWords(name)
  const compact = words.join('')
  return (
    LONG_STEMS.some((stem) => compact.includes(stem)) ||
    SHORT_TERMS.some((term) => containsTerm(words, term))
  )
}
