// app/lib/quickplay.ts
export const QUICKPLAY_LS_KEY = "ftc_quickplay_puzzle_v1";

export function saveQuickplay<T>(data: T) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(QUICKPLAY_LS_KEY, JSON.stringify(data));
  } catch {}
}

export function loadQuickplay<T>(): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(QUICKPLAY_LS_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function clearQuickplay() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(QUICKPLAY_LS_KEY);
  } catch {}
}
