import { deriveEntriesFromGrid } from "../../app/lib/publishPipeline/deriveEntries";
import { entryCrossingStats, checkedCellStats, hasShortLetterRuns, runGridValidation } from "../../app/lib/gridValidation/validateGrid";
import { PRODUCTION_RULES, type Placement, type Rules } from "./exactStructuralModel";

export function verifyExactStructure(placements: Placement[], answers: string[], rules: Rules) {
  const n = rules.size, grid = Array.from({ length: n }, () => Array<string>(n).fill("#"));
  const errors: string[] = [], vocabulary = new Set(answers);
  const own = Array.from({ length: n * n }, () => ({ across: [] as number[], down: [] as number[] }));
  for (const [i, p] of placements.entries()) {
    if (!vocabulary.has(p.answer)) errors.push("unsupplied-answer");
    for (let k = 0; k < p.answer.length; k++) {
      const row = p.row + (p.direction === "down" ? k : 0), col = p.col + (p.direction === "across" ? k : 0);
      if (row < 0 || col < 0 || row >= n || col >= n) { errors.push("bounds"); continue; }
      if (grid[row][col] !== "#" && grid[row][col] !== p.answer[k]) errors.push("letter-conflict");
      grid[row][col] = p.answer[k]; own[row * n + col][p.direction].push(i);
    }
  }
  if (own.some(o => o.across.length > 1 || o.down.length > 1)) errors.push("same-direction-overlap");
  const entries = deriveEntriesFromGrid(grid, 3);
  const key = (p: { answer: string; row: number; col: number; direction: string }) => `${p.answer}:${p.row}:${p.col}:${p.direction}`;
  const expected = new Set(placements.map(key));
  if (entries.length !== placements.length || entries.some(e => !expected.has(key(e)))) errors.push("derived-run-mismatch");
  if (entries.some(e => !vocabulary.has(e.answer))) errors.push("unsupplied-derived-answer");
  if (new Set(entries.map(e => e.answer)).size !== entries.length) errors.push("duplicate-answer");
  if (hasShortLetterRuns(grid, 3)) errors.push("short-run");
  if (entries.length < rules.minEntries || entries.length > rules.maxEntries) errors.push("entry-count");
  const across = entries.filter(e => e.direction === "across").length;
  if (across < rules.minAcross || entries.length - across < rules.minDown) errors.push("direction-balance");
  const crossings = entryCrossingStats(grid, entries, 3), checked = checkedCellStats(grid, 3);
  if (crossings.counts.some(e => e.checkedCells < rules.minChecks)) errors.push("weak-entry");
  if (checked.total * 100 < n * n * rules.densityPercent) errors.push("density");
  if (checked.checked * 100 < checked.total * rules.checkedPercent) errors.push("checked-ratio");
  // Independent graph over derived entries, rather than solver cell ranks.
  const cells = entries.map(e => new Set(Array.from({ length: e.answer.length }, (_, i) => `${e.row + (e.direction === "down" ? i : 0)}:${e.col + (e.direction === "across" ? i : 0)}`)));
  const reached = new Set<number>(), queue = entries.length ? [0] : [];
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i]; if (reached.has(a)) continue; reached.add(a);
    entries.forEach((e, b) => { if (!reached.has(b) && e.direction !== entries[a].direction && [...cells[a]].some(c => cells[b].has(c))) queue.push(b); });
  }
  const connected = entries.length > 0 && reached.size === entries.length;
  if (!connected) errors.push("disconnected");
  const isProduction = (Object.keys(PRODUCTION_RULES) as Array<keyof Rules>).every(k => rules[k] === PRODUCTION_RULES[k]);
  const production = isProduction ? runGridValidation({ grid, derived: entries, themeSet: vocabulary, policies: { isOverGenericThemeWord: () => false } }) : null;
  if (production && !production.accepted) errors.push(`production:${production.issue}`);
  return { valid: errors.length === 0, errors: [...new Set(errors)], grid, entries, crossings, checked, connected, production };
}
