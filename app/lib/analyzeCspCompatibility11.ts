import {
  extractSlotsFromPattern11,
  prepareCandidateDomains,
  type CspCandidate,
  type CrosswordSlot,
  type PreparedCandidate,
} from "./crosswordCsp11";
import type { CrosswordPattern11 } from "./crosswordPatterns11";

export type CspSlotCompatibility11 = {
  slotId: string;
  length: number;
  domainSize: number;
  letterCoverageByPosition: Array<Record<string, number>>;
};

export type CspIntersectionCompatibility11 = {
  slotA: string;
  slotALength: number;
  positionA: number;
  lettersAtA: string[];
  slotB: string;
  slotBLength: number;
  positionB: number;
  lettersAtB: string[];
  compatiblePairCount: number;
  lettersInCommon: string[];
};

export type CspCompatibilityAnalysis11 = {
  slots: CspSlotCompatibility11[];
  intersections: CspIntersectionCompatibility11[];
  zeroCompatibilityIntersections: CspIntersectionCompatibility11[];
  weakestIntersections: CspIntersectionCompatibility11[];
  patternCompatibilityScore: number;
};

export function analyzeCspCompatibility11(opts: {
  pattern: CrosswordPattern11;
  candidates: CspCandidate[];
}): CspCompatibilityAnalysis11 {
  const slots = extractSlotsFromPattern11(opts.pattern.rows);
  const prepared = prepareCandidateDomains(slots, opts.candidates);
  const domains = prepared.domainsBySlotId;
  const slotReports = slots.map((slot) => {
    const domain = domains.get(slot.id) ?? [];
    return {
      slotId: slot.id,
      length: slot.length,
      domainSize: domain.length,
      letterCoverageByPosition: buildLetterCoverage(slot.length, domain),
    };
  });

  const intersections = collectUniqueIntersections(slots).map((intersection) => {
    const domainA = domains.get(intersection.slotA.id) ?? [];
    const domainB = domains.get(intersection.slotB.id) ?? [];
    const lettersInCommon = collectLettersInCommon(
      domainA,
      intersection.positionA,
      domainB,
      intersection.positionB
    );
    return {
      slotA: intersection.slotA.id,
      slotALength: intersection.slotA.length,
      positionA: intersection.positionA,
      lettersAtA: collectLettersAt(domainA, intersection.positionA),
      slotB: intersection.slotB.id,
      slotBLength: intersection.slotB.length,
      positionB: intersection.positionB,
      lettersAtB: collectLettersAt(domainB, intersection.positionB),
      compatiblePairCount: countCompatiblePairs(domainA, intersection.positionA, domainB, intersection.positionB),
      lettersInCommon,
    };
  });
  const weakestIntersections = [...intersections].sort(compareIntersectionWeakness).slice(0, 8);
  const zeroCompatibilityIntersections = intersections.filter((item) => item.compatiblePairCount === 0);
  const minPairs =
    intersections.length > 0 ? Math.min(...intersections.map((item) => item.compatiblePairCount)) : 0;
  const averagePairs =
    intersections.length > 0
      ? intersections.reduce((sum, item) => sum + item.compatiblePairCount, 0) / intersections.length
      : 0;
  const averageLetters =
    intersections.length > 0
      ? intersections.reduce((sum, item) => sum + item.lettersInCommon.length, 0) / intersections.length
      : 0;
  const averageDomain =
    slotReports.length > 0
      ? slotReports.reduce((sum, item) => sum + item.domainSize, 0) / slotReports.length
      : 0;

  return {
    slots: slotReports,
    intersections,
    zeroCompatibilityIntersections,
    weakestIntersections,
    patternCompatibilityScore:
      (zeroCompatibilityIntersections.length === 0 ? 10_000 : 0) -
      zeroCompatibilityIntersections.length * 50_000 +
      minPairs * 80 +
      averagePairs * 4 +
      averageLetters * 45 +
      averageDomain * 8,
  };
}

function buildLetterCoverage(length: number, domain: PreparedCandidate[]): Array<Record<string, number>> {
  return Array.from({ length }, (_, position) => {
    const counts: Record<string, number> = {};
    for (const candidate of domain) {
      const letter = candidate.answer[position];
      if (!letter) continue;
      counts[letter] = (counts[letter] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function collectUniqueIntersections(slots: CrosswordSlot[]): Array<{
  slotA: CrosswordSlot;
  positionA: number;
  slotB: CrosswordSlot;
  positionB: number;
}> {
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));
  const seen = new Set<string>();
  const out: Array<{ slotA: CrosswordSlot; positionA: number; slotB: CrosswordSlot; positionB: number }> = [];

  for (const slot of slots) {
    for (const intersection of slot.intersections) {
      const other = slotById.get(intersection.otherSlotId);
      if (!other) continue;
      const [first, second] = [slot.id, other.id].sort();
      const key = `${first}:${second}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (slot.id === first) {
        out.push({
          slotA: slot,
          positionA: intersection.ownIndex,
          slotB: other,
          positionB: intersection.otherIndex,
        });
      } else {
        out.push({
          slotA: other,
          positionA: intersection.otherIndex,
          slotB: slot,
          positionB: intersection.ownIndex,
        });
      }
    }
  }

  return out.sort(
    (a, b) =>
      a.slotA.id.localeCompare(b.slotA.id) ||
      a.slotB.id.localeCompare(b.slotB.id) ||
      a.positionA - b.positionA ||
      a.positionB - b.positionB
  );
}

function countCompatiblePairs(
  domainA: PreparedCandidate[],
  positionA: number,
  domainB: PreparedCandidate[],
  positionB: number
): number {
  let count = 0;
  for (const candidateA of domainA) {
    for (const candidateB of domainB) {
      if (candidateA.answer === candidateB.answer) continue;
      if (candidateA.answer[positionA] === candidateB.answer[positionB]) count++;
    }
  }
  return count;
}

function collectLettersInCommon(
  domainA: PreparedCandidate[],
  positionA: number,
  domainB: PreparedCandidate[],
  positionB: number
): string[] {
  const aLetters = new Set(domainA.map((candidate) => candidate.answer[positionA]).filter(Boolean));
  const bLetters = new Set(domainB.map((candidate) => candidate.answer[positionB]).filter(Boolean));
  return [...aLetters].filter((letter) => bLetters.has(letter)).sort();
}

function collectLettersAt(domain: PreparedCandidate[], position: number): string[] {
  return [...new Set(domain.map((candidate) => candidate.answer[position]).filter(Boolean))].sort();
}

function compareIntersectionWeakness(
  a: CspIntersectionCompatibility11,
  b: CspIntersectionCompatibility11
): number {
  return (
    a.compatiblePairCount - b.compatiblePairCount ||
    a.lettersInCommon.length - b.lettersInCommon.length ||
    a.slotA.localeCompare(b.slotA) ||
    a.slotB.localeCompare(b.slotB) ||
    a.positionA - b.positionA ||
    a.positionB - b.positionB
  );
}
