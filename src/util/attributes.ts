/** OTel attribute values are bounded; avoid huge payloads. */
const DEFAULT_MAX = 8_000;

export function jsonAttr(value: unknown, maxLen = DEFAULT_MAX): string {
  try {
    const s = JSON.stringify(value);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    const t = String(value);
    return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
  }
}

export function textAttr(text: string | undefined, maxLen = DEFAULT_MAX): string | undefined {
  if (text == null) return undefined;
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}
