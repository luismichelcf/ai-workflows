// Small readers shared by the locks that parse JSON they did not produce.

/** True for a plain JSON object: the caller may hand us anything, including an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
