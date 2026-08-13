import type { RequestAnswerTopUpClient } from "@/app/lib/answerPipeline";

export type OpenAiGenerationLanguage = "es" | "en";

export type OpenAiGenerationCompletion = {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
    };
  }>;
};

export type OpenAiGenerationRequestArgs = {
  model: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: unknown;
  messages?: Array<{
    role: "system" | "user";
    content: string;
  }>;
};

export type OpenAiGenerationClient = RequestAnswerTopUpClient & {
  responses?: {
    create(args: Record<string, unknown>): Promise<unknown>;
  };
};

export type OpenAiGenerationChatClient = {
  chat: {
    completions: {
      create: unknown;
    };
  };
};

export type AnswerbankTextResult = {
  text: string;
  model: string;
  finishReason?: string;
  usedWebSearch: boolean;
  trustedAnswers?: string[];
  coreAnswers?: string[];
  contextAnswers?: string[];
};

export type AnswerbankModels = {
  answerbankModel: string;
  answerbankSearchModel: string;
  compactAnswerbankModel: string;
};

export type BuildAnswerbankRequestInput = {
  theme: string;
  language: OpenAiGenerationLanguage;
  size: number;
  targetAnswers: number;
  getThemeAnchors: (theme: string) => string[];
  normalizeAnswer: (answer: string) => string;
};

export type RequestAnswerbankTextInput = {
  client: OpenAiGenerationClient;
  prompt: string;
  models: Pick<AnswerbankModels, "answerbankModel" | "answerbankSearchModel">;
  allowWebSearch: boolean;
};

export type RequestCompactAnswerbankTextInput = {
  client: OpenAiGenerationClient;
  theme: string;
  language: OpenAiGenerationLanguage;
  size: number;
  models: Pick<AnswerbankModels, "compactAnswerbankModel" | "answerbankSearchModel">;
  allowWebSearch: boolean;
  target?: number;
  maxTokens?: number;
};

export type RequestLengthBucketedAnswerbankTextInput = {
  client: OpenAiGenerationClient;
  theme: string;
  language: OpenAiGenerationLanguage;
  size: number;
  answerbankSearchModel: string;
  fillerWords: readonly string[];
  spanishFillerWords: readonly string[];
  normalizeAnswer: (answer: string) => string;
  isValidAnswerCharacters: (answer: string) => boolean;
};

export type TopUpSanitizer = (
  raw: unknown,
  maxLen: number,
  language?: OpenAiGenerationLanguage
) => string[];

export type RequestTopUpAnswersInput = {
  client: OpenAiGenerationClient;
  theme: string;
  language: OpenAiGenerationLanguage;
  size: number;
  existing: string[];
  need: number;
  attempt: number;
  answerbankModel: string;
  answerbankSearchModel: string;
  sanitizeAnswerList: TopUpSanitizer;
};

export type GenerateLengthBalancedThematicAnswersInput = {
  client: OpenAiGenerationClient;
  theme: string;
  language: OpenAiGenerationLanguage;
  size: number;
  existing: string[];
  desiredByLength: Map<number, number>;
  attempt: number;
  answerbankSearchModel: string;
  sanitizeAnswerList: TopUpSanitizer;
  normalizeAnswer: (answer: string) => string;
};

export type GenerateSupportWordsInput = {
  client: OpenAiGenerationClient;
  theme: string;
  language: OpenAiGenerationLanguage;
  size: number;
  existing: string[];
  attempt: number;
  answerbankSearchModel: string;
  sanitizeAnswerList: TopUpSanitizer;
};

export type ValidateThematicAnswersInput = {
  client: OpenAiGenerationChatClient;
  theme: string;
  language: OpenAiGenerationLanguage;
  size: number;
  answers: string[];
  attempt: number;
  answerbankSearchModel: string;
  sanitizeAnswerList: TopUpSanitizer;
};
