const SENSITIVE_NAME_RE =
  /pass(word)?|secret|token|api_?key|hash|salt|otp|mfa|totp|e_?mail|phone|mobile|iban|bic|card|cvv|ssn|tax_?id|vat|passport|birth|dob|address|street|zip|postal|ip_?addr|^ip$|geo|lat(itude)?$|lng|lon(gitude)?$|salary|note|comment/i

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_RE.test(name)
}
