/**
 * Phone number parsing and validation utilities
 */

/**
 * Parse and normalize a single phone number
 * @param {string} raw - Raw phone number string
 * @param {string} defaultCountryCode - Default country code to apply (e.g., "91")
 * @returns {{ phone: string, valid: boolean, original: string, reason?: string }}
 */
export function parsePhoneNumber(raw, defaultCountryCode = "91") {
  const original = raw;
  if (!raw || typeof raw !== "string") {
    return { phone: "", valid: false, original, reason: "Empty or invalid input" };
  }

  let cleaned = raw.trim();
  const hasPlus = cleaned.startsWith("+");
  cleaned = cleaned.replace(/[\s\-\.\(\)\[\]]/g, "");
  cleaned = cleaned.replace(/[^\d+]/g, "");
  if (hasPlus) {
    cleaned = "+" + cleaned.replace(/\+/g, "");
  } else {
    cleaned = cleaned.replace(/\+/g, "");
  }

  if (cleaned.startsWith("00")) {
    cleaned = "+" + cleaned.slice(2);
  } else if (!cleaned.startsWith("+") && cleaned.startsWith("0")) {
    cleaned = cleaned.slice(1);
  }

  let digits = cleaned.replace(/^\+/, "");
  const defaultCC = String(defaultCountryCode).replace(/^\+/, "");

  if (!cleaned.startsWith("+")) {
    if (digits.length <= 10) {
      digits = defaultCC + digits;
    }
    cleaned = "+" + digits;
  } else {
    digits = cleaned.slice(1);
  }

  if (!/^\d+$/.test(digits)) {
    return { phone: cleaned, valid: false, original, reason: "Contains non-numeric characters" };
  }
  if (digits.length < 7) {
    return { phone: cleaned, valid: false, original, reason: "Too short (min 7 digits)" };
  }
  if (digits.length > 15) {
    return { phone: cleaned, valid: false, original, reason: "Too long (max 15 digits)" };
  }

  return { phone: "+" + digits, valid: true, original };
}

/**
 * Clean and validate an array of raw phone number strings
 * @param {string[]} numbersArray
 * @param {string} defaultCountryCode
 * @returns {{ valid: Array, invalid: Array }}
 */
export function cleanAndValidateNumbers(numbersArray, defaultCountryCode = "91") {
  const valid = [];
  const invalid = [];

  for (const raw of numbersArray) {
    if (!raw || String(raw).trim() === "") continue;
    const result = parsePhoneNumber(String(raw), defaultCountryCode);
    if (result.valid) {
      valid.push(result);
    } else {
      invalid.push(result);
    }
  }

  return { valid, invalid };
}

/**
 * Deduplicate contacts array by phone number
 * @param {Array<{ phone: string, name?: string, status?: string }>} contacts
 * @returns {{ unique: Array, duplicates: Array }}
 */
export function deduplicateContacts(contacts) {
  const seen = new Map();
  const unique = [];
  const duplicates = [];

  for (const contact of contacts) {
    const key = contact.phone;
    if (seen.has(key)) {
      duplicates.push(contact);
    } else {
      seen.set(key, true);
      unique.push(contact);
    }
  }

  return { unique, duplicates };
}
