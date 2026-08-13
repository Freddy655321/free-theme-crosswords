import type { WordCandidate } from "@/app/lib/crosswordTypes";

export function pickPoolForSize(
  items: WordCandidate[],
  opts: {
    size: number;
    placementCoreThemeSet: Set<string>;
    minEntryLenForSize: (size: number) => number;
  }
): WordCandidate[] {
  if (opts.size !== 11) return items;

  const thematic = items.filter((item) => opts.placementCoreThemeSet.has(item.answer));

  const takeByLen = (
    source: WordCandidate[],
    minLen: number,
    maxLen: number,
    limit: number,
    used: Set<string>
  ) => {
    const picked: WordCandidate[] = [];
    for (const item of source) {
      const len = item.answer.length;
      if (len < minLen || len > maxLen) continue;
      if (used.has(item.answer)) continue;
      picked.push(item);
      used.add(item.answer);
      if (picked.length >= limit) break;
    }
    return picked;
  };

  const used = new Set<string>();
  const next: WordCandidate[] = [];

  const thematicSorted = [...thematic].sort((a, b) => b.answer.length - a.answer.length);
  next.push(...takeByLen(thematicSorted, 8, 11, 8, used));
  next.push(...takeByLen(thematicSorted, 6, 7, 12, used));
  next.push(...takeByLen(thematicSorted, 4, 5, 10, used));
  next.push(...takeByLen(thematicSorted, opts.minEntryLenForSize(opts.size), 3, 8, used));

  for (const item of thematicSorted) {
    if (used.has(item.answer)) continue;
    next.push(item);
    used.add(item.answer);
    if (next.length >= 96) break;
  }

  return next;
}
