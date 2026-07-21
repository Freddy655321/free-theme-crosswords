import assert from "node:assert/strict";
import test from "node:test";

import {
  inBounds,
  makeSeededRng,
  normalizeAnswer,
  safeJson,
  shuffleInPlace,
} from "./crosswordUtils";

test("normalizeAnswer preserves current ASCII/digit normalization behavior", () => {
  assert.equal(normalizeAnswer(null), "");
  assert.equal(normalizeAnswer(undefined), "");
  assert.equal(normalizeAnswer(""), "");
  assert.equal(normalizeAnswer("  luna llena  "), "LUNALLENA");
  assert.equal(normalizeAnswer("wake-up dead"), "WAKEUPDEAD");
  assert.equal(normalizeAnswer("canción"), "CANCION");
  assert.equal(normalizeAnswer("mIx-42"), "MIX42");
  assert.equal(normalizeAnswer("a_b.c"), "A_B.C");
});

test("safeJson parses valid JSON and salvages object text without throwing", () => {
  assert.deepEqual(safeJson<{ ok: boolean }>("{\"ok\":true}"), { ok: true });
  assert.deepEqual(safeJson<{ ok: boolean }>("prefix {\"ok\":true} suffix"), { ok: true });
  assert.equal(safeJson("{not json"), null);
  assert.equal(safeJson(""), null);
});

test("makeSeededRng is deterministic and returns values in [0, 1)", () => {
  const a = makeSeededRng(123);
  const b = makeSeededRng(123);
  const c = makeSeededRng(124);
  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  const seqC = Array.from({ length: 8 }, () => c());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  assert.ok(seqA.every((value) => value >= 0 && value < 1));
});

test("shuffleInPlace is deterministic with a seeded RNG and preserves elements", () => {
  const first = [1, 2, 3, 4, 5, 6];
  const second = [1, 2, 3, 4, 5, 6];
  shuffleInPlace(first, makeSeededRng(99));
  shuffleInPlace(second, makeSeededRng(99));
  assert.deepEqual(first, second);
  assert.deepEqual([...first].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

test("inBounds accepts corners and rejects negatives or exact-size coordinates", () => {
  assert.equal(inBounds(11, 0, 0), true);
  assert.equal(inBounds(11, 10, 10), true);
  assert.equal(inBounds(11, -1, 0), false);
  assert.equal(inBounds(11, 0, -1), false);
  assert.equal(inBounds(11, 11, 0), false);
  assert.equal(inBounds(11, 0, 11), false);
});
