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
