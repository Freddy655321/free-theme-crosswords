/** Cooperative budget shared by indexing, domain operations and CSP search. */
export class CspDomainDeadline extends Error {
  constructor() { super("CSP domain work cancelled or deadline exceeded"); }
}

export class CspDomainBudget {
  static readonly CHECK_INTERVAL = 256;
  private pending = 0;
  constructor(
    private readonly deadlineAt = Infinity,
    private readonly cancelled: () => boolean = () => false,
    private readonly now: () => number = Date.now,
  ) {}
  check(): void {
    if (this.cancelled() || this.now() > this.deadlineAt) throw new CspDomainDeadline();
  }
  step(): void {
    if (++this.pending === CspDomainBudget.CHECK_INTERVAL) {
      this.pending = 0;
      this.check();
    }
  }
}

type AnswerRecord = { answer: string; thematic?: boolean };

/** IDs follow first normalized occurrence. Metadata is stored once per answer. */
export class CspCandidateIndex<T extends AnswerRecord> {
  private readonly records: Readonly<T>[] = [];
  private readonly answers = new Map<string, number>();
  private readonly lengths = new Map<number, readonly number[]>();
  private readonly positions = new Map<number, Map<number, Map<string, readonly number[]>>>();

  constructor(candidates: readonly T[], normalize: (answer: string) => string, readonly budget = new CspDomainBudget()) {
    budget.check();
    for (const candidate of candidates) {
      budget.step();
      const answer = normalize(candidate.answer);
      if (!answer || !/^[A-Z0-9]+$/.test(answer)) continue;
      const previous = this.answers.get(answer);
      if (previous !== undefined) {
        if (candidate.thematic && !this.records[previous].thematic) {
          this.records[previous] = Object.freeze({ ...candidate, answer });
        }
        continue;
      }
      this.answers.set(answer, this.records.length);
      this.records.push(Object.freeze({ ...candidate, answer }));
    }
    const lengths = new Map<number, number[]>();
    const positions = new Map<number, Map<number, Map<string, number[]>>>();
    for (let id = 0; id < this.records.length; id++) {
      budget.step();
      const { answer } = this.records[id];
      const lengthIds = lengths.get(answer.length) ?? [];
      lengthIds.push(id);
      lengths.set(answer.length, lengthIds);
      const byPosition = positions.get(answer.length) ?? new Map<number, Map<string, number[]>>();
      positions.set(answer.length, byPosition);
      for (let position = 0; position < answer.length; position++) {
        budget.step();
        const byCharacter = byPosition.get(position) ?? new Map<string, number[]>();
        byPosition.set(position, byCharacter);
        const ids = byCharacter.get(answer[position]) ?? [];
        ids.push(id);
        byCharacter.set(answer[position], ids);
      }
    }
    for (const [length, ids] of lengths) this.lengths.set(length, Object.freeze(ids));
    for (const [length, byPosition] of positions) {
      const frozen = new Map<number, Map<string, readonly number[]>>();
      for (const [position, byCharacter] of byPosition) {
        budget.step();
        frozen.set(position, new Map([...byCharacter].map(([character, ids]) => [character, Object.freeze(ids)])));
      }
      this.positions.set(length, frozen);
    }
    budget.check();
  }

  get size(): number { return this.records.length; }
  candidate(id: number): Readonly<T> { return this.records[id]; }
  id(answer: string): number | undefined { return this.answers.get(answer); }
  domain(length: number): CspCandidateDomain<T> {
    return new CspCandidateDomain(this, length, this.lengths.get(length) ?? []);
  }
  posting(length: number, position: number, character: string): readonly number[] {
    this.budget.check();
    return this.positions.get(length)?.get(position)?.get(character) ?? [];
  }
}

/** Immutable sorted-ID subset. Reductions share the index, never candidate objects. */
export class CspCandidateDomain<T extends AnswerRecord> implements Iterable<Readonly<T>> {
  private readonly histograms = new Map<number, ReadonlyMap<string, number>>();
  constructor(readonly index: CspCandidateIndex<T>, readonly wordLength: number, private readonly ids: readonly number[]) {}
  get length(): number { return this.ids.length; }
  has(id: number): boolean {
    let low = 0, high = this.ids.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (this.ids[middle] === id) return true;
      if (this.ids[middle] < id) low = middle + 1; else high = middle - 1;
    }
    return false;
  }
  *[Symbol.iterator](): IterableIterator<Readonly<T>> {
    this.index.budget.check();
    for (const id of this.ids) { this.index.budget.step(); yield this.index.candidate(id); }
  }
  filter(predicate: (candidate: Readonly<T>) => boolean): CspCandidateDomain<T> {
    this.index.budget.check();
    const ids: number[] = [];
    for (const id of this.ids) {
      this.index.budget.step();
      if (predicate(this.index.candidate(id))) ids.push(id);
    }
    return new CspCandidateDomain(this.index, this.wordLength, ids);
  }
  map<U>(fn: (candidate: Readonly<T>) => U): U[] {
    const result: U[] = [];
    for (const candidate of this) result.push(fn(candidate));
    return result;
  }
  intersect(other: CspCandidateDomain<T>): CspCandidateDomain<T> {
    if (this.index !== other.index) throw Error("Cannot intersect different candidate indexes");
    return this.intersectIds(other.ids);
  }
  private intersectIds(other: readonly number[]): CspCandidateDomain<T> {
    this.index.budget.check();
    const ids: number[] = [];
    let a = 0, b = 0;
    while (a < this.ids.length && b < other.length) {
      this.index.budget.step();
      if (this.ids[a] === other[b]) { ids.push(this.ids[a]); a++; b++; }
      else if (this.ids[a] < other[b]) a++; else b++;
    }
    return new CspCandidateDomain(this.index, this.wordLength, ids);
  }
  matching(position: number, character: string): CspCandidateDomain<T> {
    return this.intersectIds(this.index.posting(this.wordLength, position, character));
  }
  exclude(answers: ReadonlySet<string>): CspCandidateDomain<T> {
    this.index.budget.check();
    if (!answers.size) return this;
    const excluded = new Set<number>();
    for (const answer of answers) {
      this.index.budget.step();
      const id = this.index.id(answer);
      if (id !== undefined) excluded.add(id);
    }
    const ids: number[] = [];
    for (const id of this.ids) { this.index.budget.step(); if (!excluded.has(id)) ids.push(id); }
    return new CspCandidateDomain(this.index, this.wordLength, ids);
  }
  letterCounts(position: number): ReadonlyMap<string, number> {
    this.index.budget.check();
    const cached = this.histograms.get(position);
    if (cached) return cached;
    const counts = new Map<string, number>();
    for (const candidate of this) {
      const character = candidate.answer[position];
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
    this.histograms.set(position, counts);
    return counts;
  }
  /** Exact arc reduction, including answer uniqueness at the crossing. */
  supportedBy(position: number, other: CspCandidateDomain<T>, otherPosition: number): CspCandidateDomain<T> {
    const counts = other.letterCounts(otherPosition);
    return this.filter(candidate => {
      const count = counts.get(candidate.answer[position]) ?? 0;
      const id = other.index.id(candidate.answer);
      const selfSupport = id !== undefined && other.has(id) && candidate.answer[otherPosition] === candidate.answer[position] ? 1 : 0;
      return count > selfSupport;
    });
  }
}
