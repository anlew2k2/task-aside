const SECRET_PATTERNS = [
  [/(Authorization\s*:\s*Bearer\s+)[^\s"'`]+/gi, "$1[REDACTED]"],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]"],
  [/(\/bot)\d+:[A-Za-z0-9_-]{20,}/g, "$1[REDACTED]"],
  [/\bsk-(?:proj-|ant-api\d+-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"],
];

/**
 * Scrub configured secret values and common token/API key patterns from text.
 */
export function redactSecrets(text, extraSecrets = []) {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  let redacted = text;
  if (Array.isArray(extraSecrets) && extraSecrets.length > 0) {
    const literals = Array.from(
      new Set(
        extraSecrets
          .filter((item) => typeof item === "string" && item.trim().length >= 6)
          .map((item) => item.trim()),
      ),
    ).sort((a, b) => b.length - a.length);

    for (const secret of literals) {
      if (redacted.includes(secret)) {
        redacted = redacted.split(secret).join("[REDACTED]");
      }
    }
  }

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  return redacted;
}

/**
 * Extract sensitive credentials from normalized settings for log/artifact redaction.
 */
export function collectConfiguredSecrets(settings) {
  return [settings?.supabase?.publishable_key, settings?.telegram?.bot_token]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}
