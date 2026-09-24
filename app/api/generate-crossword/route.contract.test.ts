import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

type RouteModule = typeof import("./route");
type ContractResponse = {
  error?: string;
  theme?: string;
  language?: string;
  size?: number;
  grid?: string[][];
  entries?: Array<{
    number: number;
    row: number;
    col: number;
    direction: "across" | "down";
    answer: string;
    clue: string;
  }>;
  meta?: Record<string, unknown>;
  diagnostic?: Record<string, unknown>;
};
type ChatCompletionArgs = {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: {
    type?: string;
    json_schema?: {
      name?: string;
    };
  };
  messages?: Array<{ role?: string; content?: string }>;
};
type MockStage =
  | "answer-bank"
  | "thematic-validation"
  | "direct-grid"
  | "clues"
  | "length-topup"
  | "constraint-topup"
  | "unknown";
type MockOpenAICall = {
  stage: MockStage;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  responseFormat?: string;
};
type MockOpenAIResponse = string | Error | ((call: MockOpenAICall, args: ChatCompletionArgs) => string | Error);

const routeModulePromise = import("./route");

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "ENABLE_DIRECT_MODEL_11",
  "OPENAI_FIXED_PATTERN_GRID",
  "CROSSWORD_CSP_11_ENABLED",
  "CROSSWORD_CSP_11_DIAGNOSTIC_ONLY",
  "CROSSWORD_CSP_11_HYBRID_DIAGNOSTIC",
  "CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const DIRECT_ANSWERS = [
  "LUNA",
  "MESA",
  "CAMINO",
  "OREJITAS",
  "LIMERICO",
  "AMARILOS",
  "GENEROS",
  "OCEANIA",
  "LAGO",
  "OIMEC",
  "RMANE",
  "CEEREA",
  "AJRIRN",
  "LMMIILOI",
  "UEITCOSA",
  "NSNAOS",
  "AAOS",
];

const ANSWER_BANK_FIXTURE = [
  "TIDE",
  "WAVE",
  "REEF",
  "SAND",
  "COAST",
  "ALGAE",
  "CORAL",
  "PLANK",
  "CURRENT",
  "ESTUARY",
  "MARINE",
  "SALINE",
  "PELAGIC",
  "BENTHOS",
  "LITTORAL",
  "SEAFLOOR",
  "NUTRIENT",
  "TURBINE",
  "HARBOR",
  "SONAR",
  "TRENCH",
  "KELP",
  "TIDES",
  "WAVES",
  "REEFS",
];

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function inferStage(args: ChatCompletionArgs): MockStage {
  const schemaName = args.response_format?.json_schema?.name ?? "";
  const prompt = args.messages?.map((message) => message.content ?? "").join("\n") ?? "";
  if (schemaName === "playable_crossword_11") return "direct-grid";
  if (schemaName === "crossword_thematic_core") return "answer-bank";
  if (schemaName.startsWith("crossword_entries_len_")) return "length-topup";
  if (/KEEP ONLY entries/i.test(prompt)) return "thematic-validation";
  if (/constraint|position|requestId/i.test(prompt)) return "constraint-topup";
  if (/clues/i.test(prompt) || /\{\s*clues\s*:/i.test(prompt)) return "clues";
  return "unknown";
}

function createMockOpenAI(responses: Partial<Record<MockStage, MockOpenAIResponse>>) {
  const calls: MockOpenAICall[] = [];
  const client = {
    chat: {
      completions: {
        create: async (args: ChatCompletionArgs) => {
          const stage = inferStage(args);
          const call: MockOpenAICall = {
            stage,
            model: args.model,
            temperature: args.temperature,
            max_tokens: args.max_tokens,
            responseFormat: args.response_format?.type,
          };
          calls.push(call);
          const configured = responses[stage] ?? responses.unknown ?? JSON.stringify({ entries: [] });
          const content = typeof configured === "function" ? configured(call, args) : configured;
          if (content instanceof Error) throw content;
          return {
            model: args.model ?? "mock-model",
            choices: [
              {
                finish_reason: "stop",
                message: { content },
              },
            ],
          };
        },
      },
    },
  };
  return { client, calls };
}

function createSupabaseSmokeMock(mode: "ok" | "error" | "throw" = "ok") {
  const calls: Array<{ table: string; columns: string; count: number }> = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            async limit(count: number) {
              calls.push({ table, columns, count });
              if (mode === "throw") throw new Error("supabase smoke failure");
              if (mode === "error") return { data: null, error: { message: "mock error" } };
              return { data: [], error: null };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

function answerBankJson(answers = ANSWER_BANK_FIXTURE): string {
  return JSON.stringify({
    entries: answers.map((answer) => ({
      answer,
      canonical: answer,
      relation: `Contract fixture relation for ${answer}`,
      kind: "exact",
    })),
  });
}

function thematicKeepJson(answers: string[]): string {
  return JSON.stringify({ keep: answers.map(normalize) });
}

function directGridJson(): string {
  return JSON.stringify({
    fills: DIRECT_ANSWERS.map((answer, index) => ({
      slot: index + 1,
      answer,
      clue: `Ocean science fixture clue number ${index + 1}`,
      relation: `Ocean science contract relation number ${index + 1}`,
    })),
  });
}

function cluesJson(answers: string[], clueForAnswer?: (answer: string, index: number) => string): string {
  return JSON.stringify({
    clues: answers.map((answer, index) => ({
      answer,
      clue: clueForAnswer?.(answer, index) ?? `Ocean science thematic clue number ${index + 1}`,
    })),
  });
}

function makeRequest(body: unknown): Request {
  return new Request("http://contract.test/api/generate-crossword", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<ContractResponse> {
  return (await response.json()) as ContractResponse;
}

async function withRouteTest<T>(
  env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  fn: (route: RouteModule) => Promise<T>
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of ENV_KEYS) {
    if (key === "SUPABASE_URL" || key === "SUPABASE_SERVICE_ROLE_KEY") continue;
    delete process.env[key];
  }
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "contract-test-service-role";
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const route = await routeModulePromise;
  const supabase = createSupabaseSmokeMock("ok");
  const savedOverrides = globalThis.__generateCrosswordTestOverrides;
  globalThis.__generateCrosswordTestOverrides = {
    getSupabaseSmokeClient: () => supabase.client,
  };
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn(route);
  } finally {
    console.warn = originalWarn;
    globalThis.__generateCrosswordTestOverrides = savedOverrides;
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function installOpenAIMock(route: RouteModule, mock: ReturnType<typeof createMockOpenAI>) {
  void route;
  const previous = globalThis.__generateCrosswordTestOverrides;
  type Overrides = NonNullable<typeof globalThis.__generateCrosswordTestOverrides>;
  const createOpenAIClient: NonNullable<Overrides["createOpenAIClient"]> = () =>
    mock.client as ReturnType<NonNullable<Overrides["createOpenAIClient"]>>;
  globalThis.__generateCrosswordTestOverrides = {
    ...previous,
    createOpenAIClient,
  };
  return () => {
    globalThis.__generateCrosswordTestOverrides = previous;
  };
}

function assertErrorEnvelope(json: ContractResponse, expectedTheme: string, expectedLanguage: string) {
  assert.equal(typeof json.error, "string");
  assert.equal(json.theme, expectedTheme);
  assert.equal(json.language, expectedLanguage);
  assert.equal(json.size, 11);
  assert.equal(typeof json.meta, "object");
}

function assertGrid11(grid: unknown): asserts grid is string[][] {
  assert.ok(Array.isArray(grid));
  assert.equal(grid.length, 11);
  for (const row of grid) {
    assert.ok(Array.isArray(row));
    assert.equal(row.length, 11);
  }
}

function assertEntriesMatchGrid(json: ContractResponse) {
  assertGrid11(json.grid);
  assert.ok(Array.isArray(json.entries));
  assert.ok(json.entries.length > 0);
  for (const entry of json.entries) {
    assert.equal(typeof entry.number, "number");
    assert.equal(typeof entry.row, "number");
    assert.equal(typeof entry.col, "number");
    assert.ok(entry.direction === "across" || entry.direction === "down");
    assert.equal(typeof entry.answer, "string");
    assert.equal(typeof entry.clue, "string");
    assert.ok(entry.clue.length > 0);
    const letters = entry.answer.split("");
    const fromGrid = letters
      .map((_, index) =>
        entry.direction === "across"
          ? json.grid?.[entry.row]?.[entry.col + index]
          : json.grid?.[entry.row + index]?.[entry.col]
      )
      .join("");
    assert.equal(fromGrid, entry.answer);
  }
}

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const braceCandidates = [source.indexOf("{\r\n", start), source.indexOf("{\n", start)].filter(
    (index) => index >= 0
  );
  const brace = Math.min(...braceCandidates);
  assert.notEqual(brace, Infinity, `missing body for ${name}`);
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

test("route module import does not require Supabase env", async () => {
  const route = await routeModulePromise;
  assert.equal(typeof route.POST, "function");
});

test("missing Supabase config is non-fatal before generation handling", async () => {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];

  const route = await routeModulePromise;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  const savedOverrides = globalThis.__generateCrosswordTestOverrides;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  globalThis.__generateCrosswordTestOverrides = undefined;

  try {
    const response = await route.POST(makeRequest({ theme: "garden tools", language: "en", size: 11 }) as never);
    const json = await readJson(response);

    assert.equal(response.status, 503);
    assert.equal(json.meta?.source, "generation-error");
    assert.equal(json.meta?.reason, "OPENAI_API_KEY no configurada.");
    assert.ok(
      warnings.some((args) => JSON.stringify(args).includes("Missing env var: SUPABASE_URL")),
      "expected missing Supabase URL warning"
    );
  } finally {
    console.warn = originalWarn;
    globalThis.__generateCrosswordTestOverrides = savedOverrides;
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("request normalization without OpenAI API key preserves current error envelope", async () => {
  await withRouteTest({}, async (route) => {
    const cases = [
      { body: { theme: "ocean science", language: "en", size: 11 }, theme: "ocean science", language: "en" },
      { body: { theme: "ocean science", language: "fr", size: 11 }, theme: "ocean science", language: "es" },
      { body: { theme: "ocean science", language: "en" }, theme: "ocean science", language: "en" },
      { body: { theme: "ocean science", language: "en", size: 15 }, theme: "ocean science", language: "en" },
      { body: { language: "en", size: 11 }, theme: "general knowledge", language: "en" },
      { body: "{", theme: "general knowledge", language: "es" },
    ] as const;

    for (const item of cases) {
      const response = await route.POST(makeRequest(item.body) as Parameters<typeof route.POST>[0]);
      const json = await readJson(response);
      assert.equal(response.status, 503);
      assertErrorEnvelope(json, item.theme, item.language);
      assert.equal(json.meta?.source, "generation-error");
      assert.equal(json.meta?.reason, "OPENAI_API_KEY no configurada.");
    }
  });
});

test("route-local theme policies do not branch on historical fixture identities", () => {
  const source = readFileSync("app/api/generate-crossword/route.ts", "utf8");
  const policySource = [
    "specificThematicFallbackClue",
    "clueFromThemeNote",
    "fallbackClueForPublishRepair",
    "clueLooksOffTheme",
    "isOverGenericThemeWordForTheme",
    "inferLocalSupportWords",
  ]
    .map((name) => functionSource(source, name))
    .join("\n");

  assert.doesNotMatch(
    policySource,
    /MEGADETH|METALLICA|BARILOCHE|MENDOZA|ARGENTINA|JAPAN|JAPON|WINE|VINO|FOOD/i
  );
  assert.doesNotMatch(policySource, /themeNorm\s*===|t\s*===/);
});

test("fixture and unseen themes follow the same mocked direct-model stage sequence", async () => {
  const themes = ["Megadeth", "Medieval bridge engineering"];
  const observed: Array<{ theme: string; status: number; stages: MockStage[] }> = [];

  for (const theme of themes) {
    await withRouteTest(
      {
        OPENAI_API_KEY: "test-key",
        ENABLE_DIRECT_MODEL_11: "1",
        CROSSWORD_CSP_11_ENABLED: "false",
      },
      async (route) => {
        const mock = createMockOpenAI({
          "direct-grid": directGridJson(),
          "thematic-validation": thematicKeepJson(DIRECT_ANSWERS),
          clues: cluesJson(DIRECT_ANSWERS),
        });
        const restore = installOpenAIMock(route, mock);
        try {
          const response = await route.POST(
            makeRequest({ theme, language: "en", size: 11 }) as Parameters<typeof route.POST>[0]
          );
          observed.push({
            theme,
            status: response.status,
            stages: mock.calls.map((call) => call.stage),
          });
        } finally {
          restore();
        }
      }
    );
  }

  assert.equal(observed.length, 2);
  assert.deepEqual(observed[0].stages, observed[1].stages);
  assert.equal(observed[0].status, observed[1].status);
});

test("missing API key does not construct an OpenAI client and Supabase smoke failures are non-fatal", async () => {
  await withRouteTest({}, async (route) => {
    let openAIConstructed = false;
    const supabase = createSupabaseSmokeMock("throw");
    const previous = globalThis.__generateCrosswordTestOverrides;
    globalThis.__generateCrosswordTestOverrides = {
      ...previous,
      createOpenAIClient: () => {
        openAIConstructed = true;
        return createMockOpenAI({}).client as never;
      },
      getSupabaseSmokeClient: () => supabase.client,
    };
    try {
      const response = await route.POST(
        makeRequest({ theme: "garden tools", language: "en", size: 11 }) as Parameters<typeof route.POST>[0]
      );
      const json = await readJson(response);
      assert.equal(response.status, 503);
      assert.equal(openAIConstructed, false);
      assert.equal(supabase.calls.length, 1);
      assertErrorEnvelope(json, "garden tools", "en");
    } finally {
      globalThis.__generateCrosswordTestOverrides = previous;
    }
  });
});

test("OpenAI answer-bank errors and invalid JSON produce the current failure contract without real network", async () => {
  await withRouteTest(
    {
      OPENAI_API_KEY: "test-key",
      CROSSWORD_CSP_11_ENABLED: "true",
      CROSSWORD_CSP_11_DIAGNOSTIC_ONLY: "true",
      CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS: "800",
    },
    async (route) => {
    for (const configured of [new Error("answer bank failed"), "{not json", JSON.stringify({})]) {
      const mock = createMockOpenAI({
        "answer-bank": configured,
        "thematic-validation": thematicKeepJson([]),
        clues: cluesJson([]),
      });
      const restore = installOpenAIMock(route, mock);
      globalThis.__generateCrosswordTestOverrides = {
        ...globalThis.__generateCrosswordTestOverrides,
        timeBudgetMs: 1,
      };
      try {
        const response = await route.POST(
          makeRequest({ theme: "ancient navigation", language: "en", size: 11 }) as Parameters<typeof route.POST>[0]
        );
        const json = await readJson(response);
        assert.ok(response.status === 422 || response.status === 503);
        assertErrorEnvelope(json, "ancient navigation", "en");
        assert.ok(mock.calls.length > 0);
      } finally {
        restore();
      }
    }
    }
  );
});

test("CSP feature flags characterize legacy, diagnostic-only, and hybrid gating", async () => {
  const flagCases = [
    {
      env: { CROSSWORD_CSP_11_ENABLED: "false" },
      diagnostic: false,
      apiKey: false,
    },
    {
      env: {
        CROSSWORD_CSP_11_ENABLED: "true",
        CROSSWORD_CSP_11_DIAGNOSTIC_ONLY: "true",
        CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS: "1200",
      },
      diagnostic: true,
      apiKey: true,
    },
    {
      env: {
        CROSSWORD_CSP_11_ENABLED: "true",
        CROSSWORD_CSP_11_DIAGNOSTIC_ONLY: "true",
        CROSSWORD_CSP_11_HYBRID_DIAGNOSTIC: "true",
        CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS: "1200",
      },
      diagnostic: true,
      apiKey: true,
    },
    {
      env: { CROSSWORD_CSP_11_HYBRID_DIAGNOSTIC: "true" },
      diagnostic: false,
      apiKey: false,
    },
  ] as const;

  for (const item of flagCases) {
    await withRouteTest({ ...(item.apiKey ? { OPENAI_API_KEY: "test-key" } : {}), ...item.env }, async (route) => {
      const mock = createMockOpenAI({
        "direct-grid": directGridJson(),
        "answer-bank": answerBankJson(),
        "thematic-validation": thematicKeepJson(ANSWER_BANK_FIXTURE),
        clues: cluesJson(ANSWER_BANK_FIXTURE),
        "length-topup": JSON.stringify({ entries: [] }),
        "constraint-topup": JSON.stringify({ groups: [] }),
      });
      const restore = installOpenAIMock(route, mock);
      try {
        const response = await route.POST(
          makeRequest({ theme: "ocean science", language: "en", size: 11 }) as Parameters<typeof route.POST>[0]
        );
        const json = await readJson(response);
        if (item.diagnostic) {
          assert.equal(response.status, 422);
          assert.equal(json.error, "csp-diagnostic-failed");
          assert.equal(typeof json.diagnostic, "object");
        } else {
          assert.equal(response.status, 503);
          assert.notEqual(json.error, "csp-diagnostic-failed");
        }
      } finally {
        restore();
      }
    });
  }
});

test("diagnostic-only CSP failure returns structured 422 and skips clues", async () => {
  await withRouteTest(
    {
      OPENAI_API_KEY: "test-key",
      CROSSWORD_CSP_11_ENABLED: "true",
      CROSSWORD_CSP_11_DIAGNOSTIC_ONLY: "true",
      CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS: "1200",
    },
    async (route) => {
      const mock = createMockOpenAI({
        "answer-bank": answerBankJson(),
        "thematic-validation": thematicKeepJson(ANSWER_BANK_FIXTURE),
        "length-topup": JSON.stringify({ entries: [] }),
        "constraint-topup": JSON.stringify({ groups: [] }),
        clues: new Error("clues should not be requested after CSP construction failure"),
      });
      const restore = installOpenAIMock(route, mock);
      try {
        const response = await route.POST(
          makeRequest({ theme: "ocean science", language: "en", size: 11 }) as Parameters<typeof route.POST>[0]
        );
        const json = await readJson(response);
        assert.equal(response.status, 422);
        assert.equal(json.error, "csp-diagnostic-failed");
        assert.equal(json.diagnostic?.failureReason !== undefined, true);
        assert.ok(Array.isArray(json.diagnostic?.patternAttempts));
        assert.equal(mock.calls.some((call) => call.stage === "clues"), false);
      } finally {
        restore();
      }
    }
  );
});

test("direct-model controlled path returns the current publish contract without running legacy", async () => {
  await withRouteTest(
    {
      OPENAI_API_KEY: "test-key",
      ENABLE_DIRECT_MODEL_11: "1",
      CROSSWORD_CSP_11_ENABLED: "false",
    },
    async (route) => {
      const mock = createMockOpenAI({
        "direct-grid": directGridJson(),
        "thematic-validation": thematicKeepJson(DIRECT_ANSWERS),
        clues: cluesJson(DIRECT_ANSWERS),
      });
      const restore = installOpenAIMock(route, mock);
      try {
        const response = await route.POST(
          makeRequest({ theme: "ocean science", language: "en", size: 11 }) as Parameters<typeof route.POST>[0]
        );
        const json = await readJson(response);
        assert.equal(json.theme, "ocean science");
        assert.equal(json.language, "en");
        assert.equal(json.size, 11);
        assert.ok(response.status === 200 || response.status === 422);
        if (response.status === 200) {
          assert.equal(json.meta?.source, "direct-validated-model-11");
          assertEntriesMatchGrid(json);
          assert.equal(json.entries?.some((entry) => normalize(entry.answer) === normalize("ocean science")), false);
        } else {
          assertErrorEnvelope(json, "ocean science", "en");
          assert.ok(json.meta?.source === "publish-gate" || json.meta?.source === "generation-error");
        }
        assert.ok(mock.calls.filter((call) => call.stage === "direct-grid").length >= 1);
        assert.ok(mock.calls.some((call) => call.stage === "clues"));
      } finally {
        restore();
      }
    }
  );
});

test("clue edge cases keep current endpoint failure or fallback envelope deterministic", async () => {
  const clueCases: Array<{ name: string; clueResponse: MockOpenAIResponse }> = [
    { name: "missing", clueResponse: JSON.stringify({ clues: [] }) },
    { name: "generic", clueResponse: cluesJson(DIRECT_ANSWERS, () => "Brief definition") },
    { name: "mentions-answer", clueResponse: cluesJson(DIRECT_ANSWERS, (answer) => `Clue mentions ${answer}`) },
  ];

  for (const clueCase of clueCases) {
    await withRouteTest(
      {
        OPENAI_API_KEY: "test-key",
        ENABLE_DIRECT_MODEL_11: "1",
        CROSSWORD_CSP_11_ENABLED: "true",
        CROSSWORD_CSP_11_DIAGNOSTIC_ONLY: "true",
        CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS: "800",
      },
      async (route) => {
        const mock = createMockOpenAI({
          "direct-grid": directGridJson(),
          "thematic-validation": thematicKeepJson(DIRECT_ANSWERS),
          clues: clueCase.clueResponse,
          "answer-bank": answerBankJson(),
        });
        const restore = installOpenAIMock(route, mock);
        globalThis.__generateCrosswordTestOverrides = {
          ...globalThis.__generateCrosswordTestOverrides,
          timeBudgetMs: 1,
        };
        try {
          const response = await route.POST(
            makeRequest({ theme: "ocean science", language: "en", size: 11 }) as Parameters<typeof route.POST>[0]
          );
          const json = await readJson(response);
          assert.ok(response.status === 200 || response.status === 422 || response.status === 503, clueCase.name);
          if (response.status === 200) assertEntriesMatchGrid(json);
          else assertErrorEnvelope(json, "ocean science", "en");
          assert.ok(mock.calls.some((call) => call.stage === "clues"));
        } finally {
          restore();
        }
      }
    );
  }
});

test("OpenAI and Supabase mocks isolate tests from external services and restore process.env", async () => {
  const before = process.env.OPENAI_API_KEY;
  await withRouteTest(
    {
      OPENAI_API_KEY: "test-key",
      CROSSWORD_CSP_11_ENABLED: "true",
      CROSSWORD_CSP_11_DIAGNOSTIC_ONLY: "true",
      CROSSWORD_CSP_11_DIAGNOSTIC_BUDGET_MS: "800",
    },
    async (route) => {
    const supabase = createSupabaseSmokeMock("error");
    const mock = createMockOpenAI({
      "answer-bank": answerBankJson(),
      "thematic-validation": thematicKeepJson(ANSWER_BANK_FIXTURE),
      "length-topup": JSON.stringify({ entries: [] }),
      "constraint-topup": JSON.stringify({ groups: [] }),
    });
    const previous = globalThis.__generateCrosswordTestOverrides;
    globalThis.__generateCrosswordTestOverrides = {
      ...previous,
      getSupabaseSmokeClient: () => supabase.client,
      createOpenAIClient: () => mock.client as never,
    };
    try {
      const response = await route.POST(
        makeRequest({ theme: "urban architecture", language: "en", size: 11 }) as Parameters<typeof route.POST>[0]
      );
      assert.ok(response.status === 422 || response.status === 503);
      assert.equal(supabase.calls.length, 1);
      assert.ok(mock.calls.length > 0);
    } finally {
      globalThis.__generateCrosswordTestOverrides = previous;
    }
    }
  );
  assert.equal(process.env.OPENAI_API_KEY, before);
});
