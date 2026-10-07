// NOTE: allow digits too (e.g., TH1RT3EN, HANGAR18)
export const ASCII_A_TO_Z = /^[A-Z0-9]+$/;
export const isBlock = (c: string) => c === "#";

export function normalizeAnswer(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s|-/g, "");
}

export function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";

  return causeCode ? `${error.name}: ${error.message} (${causeCode})` : `${error.name}: ${error.message}`;
}

// Server logs only. Never use this richer diagnostic in response metadata.
// Root + three cause levels, eight total nodes, three aggregate children per node.
export function serverErrorDiagnostic(error: unknown): string {
  let remaining = 8;
  const seen = new Set<object>();
  const read = (value: object, key: string): unknown => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch { return undefined; }
  };
  const text = (value: unknown): string => {
    if (typeof value !== "string" && typeof value !== "number") return "";
    const raw = String(value);
    // Fail closed for request-like text; do not emit embedded credentials/payloads.
    if (/sk-[\w-]+|bearer\s|authorization|api[_ -]?key|password|secret|token|headers?|request\s*body|prompt|[{}]/i.test(raw)) {
      return "[redacted]";
    }
    return raw.replace(/https?:\/\/\S+/gi, "[url]").replace(/[\r\n\t]/g, " ").slice(0, 300);
  };
  const visit = (value: unknown, depth: number): string => {
    if (depth > 3 || remaining-- <= 0) return "[limit]";
    if (!value || typeof value !== "object") return "[non-error]";
    if (seen.has(value)) return "[cycle]";
    seen.add(value);
    let rawName = read(value, "name");
    try {
      let prototype = Object.getPrototypeOf(value);
      for (let i = 0; rawName === undefined && prototype && i < 3; i++) {
        rawName = read(prototype, "name");
        prototype = Object.getPrototypeOf(prototype);
      }
    } catch { /* Ignore inaccessible prototypes. */ }
    const name = text(rawName) || "Error";
    const message = text(read(value, "message"));
    const code = text(read(value, "code"));
    let result = `${name}${message ? `: ${message}` : ""}${code ? ` (${code})` : ""}`;
    const cause = read(value, "cause");
    if (cause !== undefined) result += `; cause: ${visit(cause, depth + 1)}`;
    // Node connection failures can contain AggregateError.errors.
    const errors = read(value, "errors");
    try {
      if (Array.isArray(errors)) {
        const length = read(errors, "length");
        if (typeof length === "number") {
          for (let i = 0; i < Math.min(length, 3); i++) {
            result += `; errors[${i}]: ${visit(read(errors, String(i)), depth + 1)}`;
          }
          if (length > 3) result += "; errors: [limit]";
        }
      }
    } catch { /* Malformed proxies must not affect generation. */ }
    return result;
  };
  return visit(error, 0).slice(0, 8192);
}

export function safeJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // salvage common "extra text" / truncation cases
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const sliced = text.slice(first, last + 1);
      try {
        return JSON.parse(sliced) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function shuffleInPlace<T>(arr: T[], rng: () => number) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function makeSeededRng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function inBounds(n: number, r: number, c: number) {
  return r >= 0 && r < n && c >= 0 && c < n;
}
