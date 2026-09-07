interface ErrorRecord {
  [key: string]: unknown;
}

export interface ParsedErrorEnvelope {
  message: string;
  code?: string;
  /**
   * Why the source failed, when the server says: `source_unreadable`,
   * `source_unsupported` or `source_read_timed_out`.
   *
   * The code says what went wrong; this says whether asking a different node
   * could possibly help. Unreadable and timed-out are facts about one node's
   * view of the file; unsupported is a fact about the file, and no node will
   * answer differently.
   */
  reason?: string;
}

function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as ErrorRecord
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function safeJson(value: unknown): string | undefined {
  try {
    const rendered = JSON.stringify(value);
    return rendered && rendered !== '{}' ? rendered : undefined;
  } catch {
    return undefined;
  }
}

function describe(value: unknown): string | undefined {
  const direct = nonEmptyString(value);
  if (direct) return direct;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const record = asRecord(value);
  if (!record) return undefined;

  for (const key of ['message', 'detail', 'reason', 'description', 'error_description']) {
    const nested = nonEmptyString(record[key]);
    if (nested) return nested;
  }

  return safeJson(value);
}

/**
 * Parse server error responses without assuming that `error` is a string.
 *
 * Macha endpoints may return either a simple string error or a structured
 * object such as `{ error: { code, message } }`. Keeping this tolerant avoids
 * JavaScript's otherwise unhelpful `[object Object]` coercion in diagnostics.
 */
export function parseErrorEnvelope(body: unknown, fallback: string): ParsedErrorEnvelope {
  const envelope = asRecord(body);
  if (!envelope) return { message: describe(body) ?? fallback };

  const structuredError = asRecord(envelope.error);
  const code = nonEmptyString(envelope.code)
    ?? nonEmptyString(structuredError?.code)
    // Current Macha JSON uses `{ error: "machine_code", message: "..." }`.
    // Keep an error-only string as the legacy human message shape.
    ?? (nonEmptyString(envelope.message) ? nonEmptyString(envelope.error) : undefined);

  const message = describe(envelope.message)
    ?? describe(envelope.error)
    ?? describe(envelope.detail)
    ?? fallback;

  const reason = nonEmptyString(envelope.reason) ?? nonEmptyString(structuredError?.reason);

  return { message, code, reason };
}
