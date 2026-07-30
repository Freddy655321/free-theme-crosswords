import {
  buildCspCrossword11ForEndpoint as defaultBuildCspCrossword11ForEndpoint,
  type CspBankAuditEvent11,
} from "@/app/lib/buildCspCrossword11";
import { buildCspCandidateReservoir11, cspRequiredLengthsFromPatterns11 } from "@/app/lib/buildCspCandidateReservoir11";
import {
  buildHybridCspCandidateReservoir11,
  loadLocalSupportCandidates11,
} from "@/app/lib/buildHybridCspCandidateReservoir11";
import { requestCspConstraintTopUpAnswers11 as defaultRequestCspConstraintTopUpAnswers11 } from "@/app/lib/crosswordCspConstraintTopUp11";
import { requestCspLengthTopUpAnswers11 as defaultRequestCspLengthTopUpAnswers11 } from "@/app/lib/crosswordCspTopUp11";
import { CROSSWORD_PATTERNS_11 } from "@/app/lib/crosswordPatterns11";
import {
  cspBankAuditCandidateDistribution,
  cspBankAuditDistribution,
  cspBankAuditMergeCounts,
  cspBankAuditRejectedBySet,
  cspBankAuditSetDistribution as recordCspBankAuditSetDistribution,
  type CspBankAuditReport,
} from "@/app/lib/answerPipeline";
import type { WordCandidate } from "@/app/lib/crosswordTypes";
import type {
  CspOrchestrationDependencies,
  CspOrchestrationInput,
  CspOrchestrationPrepared,
  CspOrchestrationResult,
  PrepareCspOrchestrationInput,
} from "./cspOrchestrationTypes";

function defaultWarn(message: string, payload?: Record<string, unknown>) {
  if (payload === undefined) {
    console.warn(message);
    return;
  }
  console.warn(message, payload);
}

function cspBankAuditLog(
  label: string,
  payload: Record<string, unknown>,
  warn: (message: string, payload?: Record<string, unknown>) => void = defaultWarn
) {
  warn(`[csp-bank-audit] ${label} ${JSON.stringify(payload)}`);
}

function cspDiagnosticLog(
  label: string,
  payload: Record<string, unknown>,
  warn: (message: string, payload?: Record<string, unknown>) => void
) {
  warn(`[csp-diagnostic] ${label} ${JSON.stringify(payload)}`);
}

function cspHybridDiagnosticLog(
  label: string,
  payload: Record<string, unknown>,
  warn: (message: string, payload?: Record<string, unknown>) => void
) {
  warn(`[csp-hybrid-diagnostic] ${label} ${JSON.stringify(payload)}`);
}

function cspSearchProfileLog(payload: Record<string, unknown>, warn: (message: string, payload?: Record<string, unknown>) => void) {
  warn(`[csp-search-profile] ${JSON.stringify(payload)}`);
}

function cspSearchCausalityLog(payload: Record<string, unknown>, warn: (message: string, payload?: Record<string, unknown>) => void) {
  warn(`[csp-search-causality] ${JSON.stringify(payload)}`);
}

function cspWipeoutCausalityLog(payload: Record<string, unknown>, warn: (message: string, payload?: Record<string, unknown>) => void) {
  warn(`[csp-wipeout-causality] ${JSON.stringify(payload)}`);
}

function cspBranchingDiagnosticLog(
  payload: Record<string, unknown>,
  warn: (message: string, payload?: Record<string, unknown>) => void
) {
  warn(`[csp-branching-diagnostic] ${JSON.stringify(payload)}`);
}

function cspValueOrderingDiagnosticLog(
  payload: Record<string, unknown>,
  warn: (message: string, payload?: Record<string, unknown>) => void
) {
  warn(`[csp-value-ordering-diagnostic] ${JSON.stringify(payload)}`);
}

export function cspBankAuditSetDistribution(
  report: CspBankAuditReport,
  stage: string,
  values: Iterable<string>,
  warn: (message: string, payload?: Record<string, unknown>) => void = defaultWarn
) {
  recordCspBankAuditSetDistribution(report, stage, values, (label, payload) =>
    cspBankAuditLog(label, payload, warn)
  );
}

export function prepareCspOrchestration(input: PrepareCspOrchestrationInput): CspOrchestrationPrepared {
  const warn = input.dependencies?.warn ?? defaultWarn;
  const patterns = input.dependencies?.patterns ?? CROSSWORD_PATTERNS_11;
  const cspRequiredLengths = cspRequiredLengthsFromPatterns11(patterns);
  const cspCandidateReservoir = buildCspCandidateReservoir11({
    candidates: input.rawPool,
    thematicKeep: input.thematicKeepSet,
    theme: input.theme,
    requiredLengths: cspRequiredLengths,
  });
  const hybridCspCandidateReservoir = input.hybridDiagnostic
    ? buildHybridCspCandidateReservoir11({
        thematicCandidates: cspCandidateReservoir.candidates.map((candidate) => ({
          answer: candidate.answer,
          thematic: true,
          source: candidate.source,
          kind: "thematic",
        })),
        supportCandidates: loadLocalSupportCandidates11({
          language: input.language,
          requiredLengths: cspRequiredLengths,
        }),
        theme: input.theme,
        requiredLengths: cspRequiredLengths,
      })
    : null;
  input.cspBankAuditReport.distributions.cspReservoirDistribution = Object.fromEntries(
    Object.entries(cspCandidateReservoir.distributionByLength).map(([key, value]) => [String(key), value])
  );
  cspBankAuditLog(
    "csp-reservoir",
    {
      total: cspCandidateReservoir.candidates.length,
      distributionByLength: cspCandidateReservoir.distributionByLength,
      excludedCount: cspCandidateReservoir.excluded.length,
      excludedByReason: cspCandidateReservoir.excluded.reduce<Record<string, number>>((acc, item) => {
        acc[item.reason] = (acc[item.reason] ?? 0) + 1;
        return acc;
      }, {}),
      acceptedSample: cspCandidateReservoir.candidates.slice(0, 20).map((candidate) => candidate.answer),
      rejectedSample: cspCandidateReservoir.excluded.slice(0, 20),
    },
    warn
  );
  if (hybridCspCandidateReservoir) {
    cspHybridDiagnosticLog(
      "reservoir-ready",
      {
        theme: input.theme,
        language: input.language,
        attempt: input.attempt,
        total: hybridCspCandidateReservoir.candidates.length,
        thematicCountsByLength: hybridCspCandidateReservoir.thematicCountsByLength,
        supportCountsByLength: hybridCspCandidateReservoir.supportCountsByLength,
        totalCountsByLength: hybridCspCandidateReservoir.totalCountsByLength,
      },
      warn
    );
  }

  return {
    requiredLengths: cspRequiredLengths,
    cspCandidateReservoir,
    hybridCspCandidateReservoir,
  };
}

export async function runCspOrchestration(input: CspOrchestrationInput): Promise<CspOrchestrationResult> {
  const solverPatterns = input.dependencies.patterns;
  const dependencies: CspOrchestrationDependencies = {
    now: input.dependencies.now ?? Date.now,
    warn: input.dependencies.warn ?? defaultWarn,
    patterns: solverPatterns ?? CROSSWORD_PATTERNS_11,
    buildCspCrossword11ForEndpoint:
      input.dependencies.buildCspCrossword11ForEndpoint ?? defaultBuildCspCrossword11ForEndpoint,
    requestCspLengthTopUpAnswers11:
      input.dependencies.requestCspLengthTopUpAnswers11 ?? defaultRequestCspLengthTopUpAnswers11,
    requestCspConstraintTopUpAnswers11:
      input.dependencies.requestCspConstraintTopUpAnswers11 ?? defaultRequestCspConstraintTopUpAnswers11,
    validateThematicAnswers: input.dependencies.validateThematicAnswers,
  };
  const cspTopUpCandidates: WordCandidate[] = [];
  const diagnostics = {
    auditReport: input.cspBankAuditReport,
    topUpCandidates: cspTopUpCandidates,
  };

  const finishSkipped = (reason: "disabled" | "wrong-size" | "already-attempted" | "deadline") => {
    if (input.enabled) {
      recordFinalAudit(input.prepared, input.cspBankAuditReport, cspTopUpCandidates, dependencies.warn);
    }
    return {
      status: "skipped" as const,
      attempted: false as const,
      reason,
      diagnostics,
    };
  };

  if (input.size !== 11) return finishSkipped("wrong-size");
  if (!input.enabled) return finishSkipped("disabled");
  if (input.alreadyAttempted) return finishSkipped("already-attempted");
  if (dependencies.now() >= input.deadlineMs - 12_000) return finishSkipped("deadline");

  const cspStartedAt = dependencies.now();
  dependencies.warn("[generate-crossword] csp11 config", {
    enabled: true,
    diagnosticOnly: input.diagnosticOnly,
    theme: input.theme,
    language: input.language,
    candidateCount: input.prepared.cspCandidateReservoir.candidates.length,
    deadlineRemainingMs: input.deadlineMs - dependencies.now(),
  });
  cspDiagnosticLog(
    "start",
    {
      theme: input.theme,
      language: input.language,
      attempt: input.attempt,
      elapsedMs: dependencies.now() - input.startedAtMs,
      reservoirCount: input.prepared.cspCandidateReservoir.candidates.length,
      diagnosticOnly: input.diagnosticOnly,
      totalBudgetMs: input.diagnosticOnly
        ? input.diagnosticBudgetMs
        : Math.min(24_000, input.deadlineMs - dependencies.now()),
    },
    dependencies.warn
  );
  cspBankAuditSetDistribution(
    input.cspBankAuditReport,
    "candidates-sent-to-csp-adapter",
    input.prepared.cspCandidateReservoir.candidates.map((candidate) => candidate.answer),
    dependencies.warn
  );
  const cspAttemptDeadlineMs = input.diagnosticOnly
    ? Math.min(input.deadlineMs - 1_000, dependencies.now() + input.diagnosticBudgetMs)
    : Math.min(input.deadlineMs - 12_000, dependencies.now() + 24_000);

  const cspResult = await dependencies.buildCspCrossword11ForEndpoint({
    theme: input.theme,
    language: input.language,
    candidates: input.prepared.cspCandidateReservoir.candidates.map((candidate) => ({
      answer: candidate.answer,
      thematic: candidate.thematic,
      source: candidate.source,
    })),
    seed: input.seed,
    deadlineMs: cspAttemptDeadlineMs,
    ...(solverPatterns ? { patterns: solverPatterns } : {}),
    hybrid: input.prepared.hybridCspCandidateReservoir
      ? {
          enabled: true,
          candidates: input.prepared.hybridCspCandidateReservoir.candidates,
          minThematicEntries: 8,
          targetThematicEntries: 10,
          thematicCountsByLength: input.prepared.hybridCspCandidateReservoir.thematicCountsByLength,
          supportCountsByLength: input.prepared.hybridCspCandidateReservoir.supportCountsByLength,
        }
      : undefined,
    diagnosticLog: (event) =>
      handleDiagnosticLog(event, input.theme, input.language, input.attempt, dependencies.warn),
    audit: (event) => handleAudit(event, input.cspBankAuditReport, dependencies.warn),
    topUpByLength:
      input.client && dependencies.now() < input.deadlineMs - 28_000
        ? async ({ requestedByLength, existingAnswers, attempt: cspTopUpAttempt }) => {
            let rawCspTopUpText = "";
            const topUp = await dependencies.requestCspLengthTopUpAnswers11({
              theme: input.theme,
              language: input.language,
              existingAnswers,
              requestedByLength,
              attempt: cspTopUpAttempt,
              completeJson: async (prompt) => {
                const completion = await input.client!.chat.completions.create({
                  model: input.answerbankSearchModel,
                  temperature: 0.1,
                  max_tokens: 1400,
                  response_format: { type: "json_object" },
                  messages: [
                    { role: "system", content: "Return ONLY valid JSON. No extra text." },
                    { role: "user", content: prompt },
                  ],
                });
                rawCspTopUpText = completion.choices?.[0]?.message?.content ?? "";
                return rawCspTopUpText;
              },
            });
            cspBankAuditMergeCounts(
              input.cspBankAuditReport.cspTopUpRawByLength,
              cspBankAuditDistribution(topUp.candidates.map((candidate) => candidate.answer))
            );
            cspBankAuditMergeCounts(input.cspBankAuditReport.cspTopUpRejectedByLength, {});
            cspBankAuditLog(
              "csp-topup-raw",
              {
                attempt: cspTopUpAttempt,
                requestedByLength,
                rawTextLength: rawCspTopUpText.length,
                parsedCount: topUp.candidates.length,
                parsedByLength: cspBankAuditDistribution(topUp.candidates.map((candidate) => candidate.answer)),
                rejectedByReason: topUp.rejectedByReason,
                sample: topUp.candidates.slice(0, 20).map((candidate) => candidate.answer),
              },
              dependencies.warn
            );
            const validated = await dependencies.validateThematicAnswers({
              client: input.client!,
              theme: input.theme,
              language: input.language,
              size: input.size,
              answers: topUp.candidates.map((candidate) => candidate.answer),
              attempt: cspTopUpAttempt,
            });
            const validatedSet = new Set(validated);
            const acceptedTopUps = topUp.candidates
              .filter((candidate) => validatedSet.has(candidate.answer))
              .map((candidate): WordCandidate => ({
                answer: candidate.answer,
                thematic: true,
                source: "model",
              }));
            recordAcceptedTopUps(
              input,
              cspTopUpCandidates,
              acceptedTopUps,
              topUp.candidates.map((candidate) => candidate.answer),
              "csp-topup-validation",
              "csp-topup-accepted",
              cspTopUpAttempt,
              dependencies.warn
            );
            return acceptedTopUps;
          }
        : undefined,
    topUpByConstraints:
      input.client && dependencies.now() < input.deadlineMs - 28_000
        ? async ({ requests, existingAnswers, attempt: cspTopUpAttempt }) => {
            let rawCspTopUpText = "";
            const topUp = await dependencies.requestCspConstraintTopUpAnswers11({
              theme: input.theme,
              language: input.language,
              excludedAnswers: existingAnswers,
              requests,
              attempt: cspTopUpAttempt,
              completeJson: async (prompt) => {
                const completion = await input.client!.chat.completions.create({
                  model: input.answerbankSearchModel,
                  temperature: 0.1,
                  max_tokens: 1600,
                  response_format: { type: "json_object" },
                  messages: [
                    { role: "system", content: "Return ONLY valid JSON. No extra text." },
                    { role: "user", content: prompt },
                  ],
                });
                rawCspTopUpText = completion.choices?.[0]?.message?.content ?? "";
                return rawCspTopUpText;
              },
            });
            cspBankAuditMergeCounts(
              input.cspBankAuditReport.cspTopUpRawByLength,
              cspBankAuditDistribution(topUp.candidates.map((candidate) => candidate.answer))
            );
            cspBankAuditLog(
              "csp-constraint-topup-raw",
              {
                attempt: cspTopUpAttempt,
                requests,
                rawTextLength: rawCspTopUpText.length,
                parsedCount: topUp.candidates.length,
                parsedByLength: cspBankAuditDistribution(topUp.candidates.map((candidate) => candidate.answer)),
                rejectedByReason: topUp.rejectedByReason,
                acceptedByRequestId: topUp.acceptedByRequestId,
                sample: topUp.candidates.slice(0, 20).map((candidate) => candidate.answer),
              },
              dependencies.warn
            );
            const validated = await dependencies.validateThematicAnswers({
              client: input.client!,
              theme: input.theme,
              language: input.language,
              size: input.size,
              answers: topUp.candidates.map((candidate) => candidate.answer),
              attempt: cspTopUpAttempt,
            });
            const validatedSet = new Set(validated);
            const acceptedTopUps = topUp.candidates
              .filter((candidate) => validatedSet.has(candidate.answer))
              .map((candidate): WordCandidate => ({
                answer: candidate.answer,
                thematic: true,
                source: "model",
              }));
            recordAcceptedTopUps(
              input,
              cspTopUpCandidates,
              acceptedTopUps,
              topUp.candidates.map((candidate) => candidate.answer),
              "csp-constraint-topup-validation",
              "csp-constraint-topup-accepted",
              cspTopUpAttempt,
              dependencies.warn
            );
            return acceptedTopUps;
          }
        : undefined,
  });

  const lastCspAttemptMeta = cspResult.ok
    ? cspResult.meta
    : {
        attempted: true,
        reason: cspResult.reason,
        elapsedMs: dependencies.now() - cspStartedAt,
        ...cspResult.meta,
      };
  if (cspResult.ok) {
    for (const answer of cspResult.usedAnswers) {
      const sourceCandidate = [...input.prepared.cspCandidateReservoir.candidates, ...cspTopUpCandidates].find(
        (candidate) => candidate.answer === answer
      );
      if (sourceCandidate?.thematic) {
        input.thematicKeepSet.add(answer);
        input.publishThemeSet.add(answer);
        input.placementThemeSet.add(answer);
      }
    }
    const crossword = {
      grid: cspResult.grid,
      usedAnswers: cspResult.usedAnswers,
      meta: {
        ...cspResult.meta,
        cspAttempt: lastCspAttemptMeta,
      },
    };
    dependencies.warn("[generate-crossword] csp11 accepted", {
      patternId: cspResult.patternId,
      entries: cspResult.usedAnswers.length,
      nodesVisited: cspResult.meta.nodesVisited,
      backtracks: cspResult.meta.backtracks,
      cspElapsedMs: cspResult.meta.cspElapsedMs,
    });
    recordFinalAudit(input.prepared, input.cspBankAuditReport, cspTopUpCandidates, dependencies.warn);
    return {
      status: "accepted",
      attempted: true,
      crossword,
      diagnostics,
      metadata: {
        attemptMeta: lastCspAttemptMeta,
      },
    };
  }

  dependencies.warn("[generate-crossword] csp11 failed; falling back to legacy", {
    reason: cspResult.reason,
    elapsedMs: dependencies.now() - cspStartedAt,
    meta: cspResult.meta,
  });
  cspDiagnosticLog(
    "failed",
    {
      theme: input.theme,
      language: input.language,
      attempt: input.attempt,
      elapsedMs: dependencies.now() - cspStartedAt,
      failureReason: cspResult.reason,
      diagnosticOnly: input.diagnosticOnly,
    },
    dependencies.warn
  );
  if (input.diagnosticOnly) {
    const diagnostic =
      typeof cspResult.meta.diagnostic === "object" && cspResult.meta.diagnostic !== null
        ? (cspResult.meta.diagnostic as Record<string, unknown>)
        : {};
    const afterCspTopUpDistribution = cspBankAuditDistribution(
      [...input.prepared.cspCandidateReservoir.candidates, ...cspTopUpCandidates].map((candidate) => candidate.answer)
    );
    const responsePayload = {
      error: "csp-diagnostic-failed",
      theme: input.theme,
      language: input.language,
      size: input.size,
      diagnostic: {
        failureReason: cspResult.reason,
        reservoirCountsByLength: input.prepared.cspCandidateReservoir.distributionByLength,
        postTopUpReservoirCountsByLength:
          diagnostic.postTopUpReservoirCountsByLength ?? afterCspTopUpDistribution,
        patternAttempts: cspResult.meta.patternDiagnostics ?? diagnostic.patternAttempts ?? [],
        elapsedMs: dependencies.now() - cspStartedAt,
        ...diagnostic,
        cspAttemptMeta: {
          attempted: true,
          reason: cspResult.reason,
          source: cspResult.meta.source,
          algorithm: cspResult.meta.algorithm,
          cspElapsedMs: cspResult.meta.cspElapsedMs,
          cspTopUpCalls: cspResult.meta.cspTopUpCalls,
          cspConstraintTopUpCalls: cspResult.meta.cspConstraintTopUpCalls,
        },
        bankAudit: {
          rawPoolDistribution: input.cspBankAuditReport.distributions.rawPoolDistribution,
          cspReservoirDistribution: input.cspBankAuditReport.distributions.cspReservoirDistribution,
          legacyPoolDistribution: input.cspBankAuditReport.distributions.legacyPoolDistribution,
          cspAdapterDistribution: input.cspBankAuditReport.distributions["csp-adapter-output"],
          afterCspTopUpDistribution,
        },
      },
    };
    return {
      status: "diagnostic",
      attempted: true,
      reason: cspResult.reason,
      diagnostics: {
        ...diagnostics,
        responsePayload,
      },
      metadata: {
        attemptMeta: lastCspAttemptMeta,
      },
    };
  }

  recordFinalAudit(input.prepared, input.cspBankAuditReport, cspTopUpCandidates, dependencies.warn);
  return {
    status: "rejected",
    attempted: true,
    reason: cspResult.reason,
    diagnostics,
    metadata: {
      attemptMeta: lastCspAttemptMeta,
    },
  };
}

function handleDiagnosticLog(
  event: CspBankAuditEvent11,
  theme: string,
  language: "es" | "en",
  attempt: number,
  warn: (message: string, payload?: Record<string, unknown>) => void
) {
  cspDiagnosticLog(
    event.stage,
    {
      theme,
      language,
      attempt,
      ...event.data,
    },
    warn
  );
  if (event.stage.startsWith("hybrid-")) {
    cspHybridDiagnosticLog(
      event.stage.replace(/^hybrid-/, ""),
      {
        theme,
        language,
        attempt,
        ...event.data,
      },
      warn
    );
  }
  if (event.stage === "search-profile") {
    cspSearchProfileLog(
      {
        theme,
        language,
        attempt,
        ...event.data,
      },
      warn
    );
    const profile = event.data.profile as
      | {
          searchCausality?: {
            summary?: unknown;
            depthProfile?: unknown;
            slotRankings?: unknown;
            earlyDecisionRankings?: unknown;
            candidateRankings?: unknown;
            wipeoutRankings?: unknown;
            branchingDiagnostics?: unknown;
            valueOrderingDiagnostics?: unknown;
            instrumentation?: unknown;
          };
        }
      | undefined;
    const searchCausality = profile?.searchCausality;
    if (searchCausality) {
      cspSearchCausalityLog(
        {
          theme,
          language,
          attempt,
          phase: event.data.phase,
          summary: searchCausality.summary,
          depthProfile: searchCausality.depthProfile,
          slotRankings: searchCausality.slotRankings,
          earlyDecisionRankings: searchCausality.earlyDecisionRankings,
          candidateRankings: searchCausality.candidateRankings,
          instrumentation: searchCausality.instrumentation,
        },
        warn
      );
      cspWipeoutCausalityLog(
        {
          theme,
          language,
          attempt,
          phase: event.data.phase,
          wipeoutRankings: searchCausality.wipeoutRankings,
        },
        warn
      );
      cspBranchingDiagnosticLog(
        {
          theme,
          language,
          attempt,
          phase: event.data.phase,
          branchingDiagnostics: searchCausality.branchingDiagnostics,
        },
        warn
      );
      cspValueOrderingDiagnosticLog(
        {
          theme,
          language,
          attempt,
          phase: event.data.phase,
          valueOrderingDiagnostics: searchCausality.valueOrderingDiagnostics,
        },
        warn
      );
    }
  }
}

function handleAudit(
  event: CspBankAuditEvent11,
  cspBankAuditReport: CspBankAuditReport,
  warn: (message: string, payload?: Record<string, unknown>) => void
) {
  cspBankAuditLog(`csp-${event.stage}`, event.data, warn);
  if (event.stage === "adapted-candidates") {
    const stats = event.data.stats as
      | {
          totalByLength?: Record<string | number, number>;
          rejectedByReason?: Record<string, number>;
        }
      | undefined;
    if (stats?.totalByLength) {
      cspBankAuditReport.distributions["csp-adapter-output"] = Object.fromEntries(
        Object.entries(stats.totalByLength).map(([key, value]) => [String(key), value])
      );
    }
    if (stats?.rejectedByReason) {
      cspBankAuditReport.cspAdapterRejectedByReason = {
        ...cspBankAuditReport.cspAdapterRejectedByReason,
        ...stats.rejectedByReason,
      };
    }
    cspBankAuditReport.cspCandidateCount =
      typeof event.data.cspCandidateCount === "number"
        ? event.data.cspCandidateCount
        : cspBankAuditReport.cspCandidateCount;
  }
  if (event.stage === "solve-diagnostics") {
    const requested = event.data.requestedTopUpByLength as Record<string | number, number> | undefined;
    if (requested) {
      cspBankAuditReport.cspRequestedTopUpByLength = Object.fromEntries(
        Object.entries(requested).map(([key, value]) => [String(key), value])
      );
    }
    const attempts = Array.isArray(event.data.attempts) ? event.data.attempts : [];
    cspBankAuditReport.cspDomainDiagnostics = attempts;
    const firstMissing = attempts.find(
      (item): item is { missingByLength: Record<string | number, number> } =>
        typeof item === "object" &&
        item !== null &&
        Object.keys((item as { missingByLength?: Record<string | number, number> }).missingByLength ?? {}).length > 0
    );
    if (firstMissing) {
      cspBankAuditReport.cspMissingLengths = Object.fromEntries(
        Object.entries(firstMissing.missingByLength).map(([key, value]) => [String(key), value])
      );
    } else {
      cspBankAuditReport.cspMissingLengths = {};
    }
  }
  if (event.stage === "topup-returned") {
    const returnedByLength = event.data.returnedByLength as Record<string | number, number> | undefined;
    if (returnedByLength) {
      const afterCspTopUp = cspBankAuditReport.distributions["after-csp-topup"] ?? {};
      cspBankAuditMergeCounts(afterCspTopUp, returnedByLength);
      cspBankAuditReport.distributions["after-csp-topup"] = afterCspTopUp;
    }
  }
}

function recordAcceptedTopUps(
  input: CspOrchestrationInput,
  cspTopUpCandidates: WordCandidate[],
  acceptedTopUps: WordCandidate[],
  rawAnswers: string[],
  validationStage: string,
  acceptedLogLabel: string,
  cspTopUpAttempt: number,
  warn: (message: string, payload?: Record<string, unknown>) => void
) {
  cspBankAuditMergeCounts(
    input.cspBankAuditReport.cspTopUpAcceptedByLength,
    cspBankAuditCandidateDistribution(acceptedTopUps)
  );
  cspBankAuditRejectedBySet(
    input.cspBankAuditReport,
    validationStage,
    rawAnswers,
    acceptedTopUps.map((candidate) => candidate.answer),
    "failed-thematic-validation"
  );
  cspBankAuditMergeCounts(
    input.cspBankAuditReport.cspTopUpRejectedByLength,
    cspBankAuditDistribution(rawAnswers.filter((answer) => !acceptedTopUps.some((candidate) => candidate.answer === answer)))
  );
  cspBankAuditLog(
    acceptedLogLabel,
    {
      attempt: cspTopUpAttempt,
      acceptedCount: acceptedTopUps.length,
      acceptedByLength: cspBankAuditCandidateDistribution(acceptedTopUps),
      rejectedByReason: input.cspBankAuditReport.rejectedByStage[validationStage] ?? {},
      sample: acceptedTopUps.slice(0, 20).map((candidate) => candidate.answer),
    },
    warn
  );
  for (const candidate of acceptedTopUps) {
    cspTopUpCandidates.push(candidate);
    input.thematicKeepSet.add(candidate.answer);
    input.publishThemeSet.add(candidate.answer);
    input.placementThemeSet.add(candidate.answer);
  }
}

function recordFinalAudit(
  prepared: CspOrchestrationPrepared,
  cspBankAuditReport: CspBankAuditReport,
  cspTopUpCandidates: WordCandidate[],
  warn: (message: string, payload?: Record<string, unknown>) => void
) {
  cspBankAuditReport.distributions.afterCspTopUp = cspBankAuditDistribution(
    [...prepared.cspCandidateReservoir.candidates, ...cspTopUpCandidates].map((candidate) => candidate.answer)
  );
  cspBankAuditLog(
    "final report",
    {
      ...cspBankAuditReport,
      rejectedByStage: cspBankAuditReport.rejectedByStage,
      rejectedSamplesByStage: cspBankAuditReport.rejectedSamplesByStage,
      samplesByStage: cspBankAuditReport.samplesByStage,
    },
    warn
  );
}
