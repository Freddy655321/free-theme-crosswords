import assert from "node:assert/strict";
import test from "node:test";

import {
  errorSummary,
  serverErrorDiagnostic,
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

test("errorSummary preserves current Error and cause-code formatting", () => {
  assert.equal(errorSummary("plain"), "plain");
  assert.equal(errorSummary(new Error("boom")), "Error: boom");

  const error = new Error("failed") as Error & { cause?: { code: string } };
  error.cause = { code: "ECONNRESET" };
  assert.equal(errorSummary(error), "Error: failed (ECONNRESET)");
});

test("server diagnostic preserves nested evidence without changing summaries or inputs", () => {
  const cause = Object.freeze(Object.assign(new Error("certificate failed"), { code: "CERT_TEST" }));
  const fetchError = Object.freeze(new TypeError("fetch failed", { cause }));
  const error = Object.freeze(new Error("Connection error.", { cause: fetchError }));
  assert.equal(errorSummary(error), "Error: Connection error.");
  assert.equal(serverErrorDiagnostic(error), "Error: Connection error.; cause: TypeError: fetch failed; cause: Error: certificate failed (CERT_TEST)");
  assert.equal(error.cause, fetchError);
  assert.equal(fetchError.cause, cause);
  assert.equal(cause.code, "CERT_TEST");
});

test("server diagnostic bounds depth, aggregate children, cycles and text", () => {
  let error = new Error("outside-bound");
  for (let i = 3; i >= 0; i--) error = new Error(`level-${i}`, { cause: error });
  const diagnostic = serverErrorDiagnostic(error);
  assert.match(diagnostic, /level-3; cause: \[limit\]/);
  assert.doesNotMatch(diagnostic, /outside-bound/);
  const aggregate = new AggregateError(Array.from({ length: 10 }, (_, i) => new Error(`child-${i}`)), "aggregate");
  assert.match(serverErrorDiagnostic(aggregate), /AggregateError: aggregate/);
  assert.doesNotMatch(serverErrorDiagnostic(aggregate), /child-3/);
  const cyclic = new Error("cycle") as Error & { cause: unknown };
  cyclic.cause = cyclic;
  assert.match(serverErrorDiagnostic(cyclic), /\[cycle\]/);
  assert.equal(serverErrorDiagnostic(new Error("x".repeat(10000))).length, 307);
});

test("server diagnostic excludes sensitive properties and handles malformed causes", () => {
  const error = Object.assign(new Error("safe"), {
    headers: { authorization: "secret-header" }, body: "secret-body", prompt: "secret-prompt",
    apiKey: "secret-key", request: { anything: "secret-request" },
    cause: { message: "nested", code: "ECONNRESET", unrelated: "secret-other" },
  });
  assert.doesNotMatch(serverErrorDiagnostic(error), /secret/);
  for (const message of ["Bearer secret", "sk-test-secret", "authorization: secret", "prompt: secret"]) {
    assert.equal(serverErrorDiagnostic(new Error(message)), "Error: [redacted]");
  }
  for (const cause of [null, 1, "secret", Symbol("secret"), { toString() { throw new Error(); } },
    Object.defineProperty({}, "message", { get() { throw new Error(); } })]) {
    assert.doesNotThrow(() => serverErrorDiagnostic(new Error("safe", { cause })));
  }
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  assert.doesNotThrow(() => serverErrorDiagnostic(proxy.proxy));
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
