/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           DevElevator  ·  AI Service  ·  Multi-SDK Router       ║
 * ║  Unified interface over OpenAI · Anthropic · Google Gen AI      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
} from "@google/generative-ai";
import { getEncoding } from "js-tiktoken";
import { logger } from "../config/logger";

// ─── ANSI log palette ────────────────────────────────────────────────────────
const FX = {
  violet: (s: string) => `\x1b[38;5;135m${s}\x1b[0m`,
  fuchsia: (s: string) => `\x1b[38;5;199m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[38;5;51m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const aiLog = (level: "info" | "warn" | "error", msg: string, meta?: object) => {
  const tag = FX.violet("▸ AI-IN-FLIGHT");
  const formatted = `${tag} ${FX.fuchsia("DevElevator")} ${FX.dim("›")} ${msg}`;
  logger[level](formatted, meta);
};

// ─── Shared Message Type ─────────────────────────────────────────────────────

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ─── Internal Error Types ────────────────────────────────────────────────────

export class AIError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: "rate_limit" | "overloaded" | "context_length" | "auth" | "unknown",
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "AIError";
  }
}

// ─── Model Registry ──────────────────────────────────────────────────────────

export type Provider = "openai" | "anthropic" | "google";

export interface ModelConfig {
  provider: Provider;
  label: string;
  useCase: string;
  contextWindow: number;   // in tokens
  apiKeyEnv: string;
  /**
   * Relative cost weight (1 = cheapest).
   * Used by the rate limiter to deduct weighted credits from the user's daily budget.
   * FREE tier cannot use models with cost > 1.
   */
  cost: number;
  /** Extra OpenAI-compat baseURL (DeepSeek, Qwen, etc.) */
  baseURL?: string;
}

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  "claude-opus-4-5": {
    provider: "anthropic",
    label: "Claude Opus 4.5",
    useCase: "High-level architecture & refactoring",
    contextWindow: 200_000,
    cost: 5,
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  "gpt-4o": {
    provider: "openai",
    label: "GPT-4o",
    useCase: "Risky migrations & tricky debugging",
    contextWindow: 128_000,
    cost: 1,
    apiKeyEnv: "OPENAI_API_KEY",
  },
  "gemini-2.5-pro-preview-05-06": {
    provider: "google",
    label: "Gemini 2.5 Pro",
    useCase: "Analyzing the entire repository at once",
    contextWindow: 1_000_000,
    cost: 3,
    apiKeyEnv: "GEMINI_API_KEY",
  },
  "claude-sonnet-4-5": {
    provider: "anthropic",
    label: "Claude Sonnet 4.5",
    useCase: "Daily tickets & iterative building",
    contextWindow: 200_000,
    cost: 2,
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  "deepseek-chat": {
    provider: "openai",
    label: "DeepSeek-V3",
    useCase: "Rapid iterations & competitive coding",
    contextWindow: 64_000,
    cost: 1,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com",
  },
  "qwen-coder-plus-latest": {
    provider: "openai",
    label: "Qwen3-Coder",
    useCase: "Autonomous agent-based coding",
    contextWindow: 128_000,
    cost: 1,
    apiKeyEnv: "QWEN_API_KEY",
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
};

export const DEFAULT_MODEL = "gpt-4o";

/** Always returns a valid ModelConfig, falling back to DEFAULT_MODEL. */
function resolveConfig(modelId: string): { id: string; config: ModelConfig } {
  const config = MODEL_CONFIGS[modelId];
  if (config) return { id: modelId, config };
  const fallback = MODEL_CONFIGS[DEFAULT_MODEL] as ModelConfig;
  aiLog("warn", `Unknown model "${modelId}" — falling back to ${FX.violet(fallback.label)}`);
  return { id: DEFAULT_MODEL, config: fallback };
}

// ─── js-tiktoken Token Counter ────────────────────────────────────────────────
//
// cl100k_base ≈ GPT-4 / Claude / Gemini tokenizer (close enough for trimming).
// We cache the encoder as a process-level singleton to avoid re-init overhead.
// Budget is 80% of the model's contextWindow to leave room for the response.

let _enc: ReturnType<typeof getEncoding> | null = null;
function getEncoder() {
  if (!_enc) _enc = getEncoding("cl100k_base");
  return _enc;
}

function countTokens(text: string): number {
  try {
    return getEncoder().encode(text).length;
  } catch {
    // Fallback heuristic if encoding fails (e.g., unusual unicode)
    return Math.ceil(text.length / 4);
  }
}


// ─── Token Trimmer ────────────────────────────────────────────────────────────

export function trimMessages(
  messages: AIMessage[],
  modelId: string,
): AIMessage[] {
  const { config } = resolveConfig(modelId);
  const budgetTokens = Math.floor(config.contextWindow * 0.80);

  // Separate system prompt from conversational history
  const systemMsg: AIMessage | undefined = messages[0]?.role === "system" ? messages[0] : undefined;
  const conversational: AIMessage[] = systemMsg ? messages.slice(1) : messages;

  const systemTokens = systemMsg ? countTokens(systemMsg.content) : 0;
  let remaining = budgetTokens - systemTokens;

  // Walk from newest → oldest, keep messages that fit within the 80% budget
  const kept: AIMessage[] = [];
  for (let i = conversational.length - 1; i >= 0; i--) {
    const msg = conversational[i];
    if (!msg) break;
    const t = countTokens(msg.content);
    if (t > remaining) break;
    kept.unshift(msg);
    remaining -= t;
  }

  const dropped = conversational.length - kept.length;
  if (dropped > 0) {
    aiLog(
      "warn",
      `${FX.cyan("Context Trim")} — dropped ${FX.fuchsia(String(dropped))} messages for model ${FX.violet(config.label)} (budget: ${budgetTokens.toLocaleString()} tokens)`,
    );
  }

  return systemMsg ? [systemMsg, ...kept] : kept;
}

// ─── Provider Error Translation ───────────────────────────────────────────────

function translateError(provider: Provider, raw: unknown): AIError {
  const msg = raw instanceof Error ? raw.message : String(raw);

  if (provider === "openai") {
    const err = raw as any;
    if (err?.status === 429) return new AIError(provider, "rate_limit", `OpenAI rate limit: ${msg}`, true);
    if (err?.status === 400 && msg.includes("context")) return new AIError(provider, "context_length", `OpenAI context overflow: ${msg}`);
    if (err?.status === 401) return new AIError(provider, "auth", `OpenAI auth failed: ${msg}`);
  }

  if (provider === "anthropic") {
    const err = raw as any;
    if (err?.status === 529 || msg.toLowerCase().includes("overloaded"))
      return new AIError(provider, "overloaded", `Anthropic overloaded: ${msg}`, true);
    if (err?.status === 429) return new AIError(provider, "rate_limit", `Anthropic rate limit: ${msg}`, true);
    if (err?.status === 401) return new AIError(provider, "auth", `Anthropic auth failed: ${msg}`);
  }

  if (provider === "google") {
    if (msg.includes("RESOURCE_EXHAUSTED")) return new AIError(provider, "rate_limit", `Google rate limit: ${msg}`, true);
    if (msg.includes("INVALID_ARGUMENT") && msg.includes("token"))
      return new AIError(provider, "context_length", `Google context overflow: ${msg}`);
  }

  return new AIError(provider, "unknown", `${provider} error: ${msg}`);
}

// ─── Client Helpers ───────────────────────────────────────────────────────────

function requireKey(envVar: string, modelId: string): string {
  const key = process.env[envVar];
  if (!key) {
    const provider = MODEL_CONFIGS[modelId]?.provider || "unknown";
    throw new AIError(
      provider as Provider,
      "auth",
      `Missing API Key for ${modelId}. Please set ${envVar} in your environment variables.`,
    );
  }
  return key;
}

function buildOpenAIClient(modelId: string, config: ModelConfig): OpenAI {
  const apiKey = requireKey(config.apiKeyEnv, modelId);
  return new OpenAI({
    apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });
}

// ─── Public Interfaces ────────────────────────────────────────────────────────

export interface CallAIOptions {
  model: string;
  messages: AIMessage[];
  temperature?: number;
  stream: false;
}

export interface CallAIStreamOptions {
  model: string;
  messages: AIMessage[];
  temperature?: number;
  stream: true;
  /** Callback invoked with each text delta (use instead of iterating) */
  onChunk: (delta: string) => void;
  /** Called when the stream ends */
  onDone: (fullText: string) => void;
  /** Called on error */
  onError: (err: AIError) => void;
}

// ─── Non-Streaming ────────────────────────────────────────────────────────────

export async function callAI(options: CallAIOptions): Promise<string> {
  const { id: resolvedId, config } = resolveConfig(options.model);
  const trimmed = trimMessages(options.messages, resolvedId);

  aiLog("info", `${FX.cyan("callAI")} model=${FX.violet(config.label)} msgs=${trimmed.length} temp=${options.temperature ?? 0.2}`);

  try {
    if (config.provider === "anthropic") {
      return await callAnthropic(resolvedId, config, trimmed, options.temperature ?? 0.2);
    }
    if (config.provider === "google") {
      return await callGoogle(resolvedId, config, trimmed, options.temperature ?? 0.2);
    }
    // Default: OpenAI-compatible
    const client = buildOpenAIClient(resolvedId, config);
    const res = await client.chat.completions.create({
      model: resolvedId,
      messages: trimmed as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature: options.temperature ?? 0.2,
      stream: false,
    });
    return res.choices[0]?.message?.content ?? "";

  } catch (raw) {
    const err = translateError(config.provider, raw);
    aiLog("error", `${FX.fuchsia("callAI failed")} [${err.code}] ${err.message}`, { retryable: err.retryable });
    throw err;
  }
}

// ─── Streaming ────────────────────────────────────────────────────────────────

export async function callAIStream(options: CallAIStreamOptions): Promise<void> {
  console.log("👉 FUNCTION EXECUTED: callAIStream");
  const { id: resolvedId, config } = resolveConfig(options.model);
  const trimmed = trimMessages(options.messages, resolvedId);

  aiLog("info", `${FX.cyan("callAIStream")} model=${FX.violet(config.label)} msgs=${trimmed.length} temp=${options.temperature ?? 0.3}`);

  try {
    if (config.provider === "anthropic") {
      await streamAnthropic(resolvedId, config, trimmed, options);
      return;
    }
    if (config.provider === "google") {
      await streamGoogle(resolvedId, config, trimmed, options);
      return;
    }
    // OpenAI-compatible streaming
    await streamOpenAI(resolvedId, config, trimmed, options);

  } catch (raw) {
    const err = raw instanceof AIError ? raw : translateError(config.provider, raw);
    aiLog("error", `${FX.fuchsia("callAIStream failed")} [${err.code}] ${err.message}`, { retryable: err.retryable });
    options.onError(err);
  }
}

// ─── OpenAI-Compatible Stream ─────────────────────────────────────────────────

async function streamOpenAI(
  modelId: string,
  config: ModelConfig,
  messages: AIMessage[],
  opts: CallAIStreamOptions,
): Promise<void> {
  const client = buildOpenAIClient(modelId, config);
  const stream = await client.chat.completions.create({
    model: modelId,
    messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    temperature: opts.temperature ?? 0.3,
    stream: true,
  });

  let full = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) { opts.onChunk(delta); full += delta; }
  }
  opts.onDone(full);
}

// ─── Anthropic Stream ─────────────────────────────────────────────────────────

async function callAnthropic(
  modelId: string,
  config: ModelConfig,
  messages: AIMessage[],
  temperature: number,
): Promise<string> {
  const apiKey = requireKey(config.apiKeyEnv, modelId);
  const client = new Anthropic({ apiKey });

  // Separate system from conversational turns
  const systemMsg = messages.find((m) => m.role === "system");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 8192,
    temperature,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: turns,
  });

  return response.content[0]?.type === "text" ? response.content[0].text : "";
}

async function streamAnthropic(
  modelId: string,
  config: ModelConfig,
  messages: AIMessage[],
  opts: CallAIStreamOptions,
): Promise<void> {
  const apiKey = requireKey(config.apiKeyEnv, modelId);
  const client = new Anthropic({ apiKey });

  const systemMsg = messages.find((m) => m.role === "system");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  let full = "";
  const stream = await client.messages.stream({
    model: modelId,
    max_tokens: 8192,
    temperature: opts.temperature ?? 0.3,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: turns,
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      const delta = event.delta.text;
      opts.onChunk(delta);
      full += delta;
    }
  }
  opts.onDone(full);
}

// ─── Google Generative AI ─────────────────────────────────────────────────────

async function callGoogle(
  modelId: string,
  config: ModelConfig,
  messages: AIMessage[],
  temperature: number,
): Promise<string> {
  const apiKey = requireKey(config.apiKeyEnv, modelId);
  const genAI = new GoogleGenerativeAI(apiKey);
  const systemText = messages.find((m) => m.role === "system")?.content;
  const gemini = genAI.getGenerativeModel({
    model: modelId,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
    generationConfig: { temperature },
    ...(systemText ? { systemInstruction: systemText } : {}),
  });

  const contents = toGoogleContents(messages);
  const result = await gemini.generateContent({ contents });
  return result.response.text();
}

async function streamGoogle(
  modelId: string,
  config: ModelConfig,
  messages: AIMessage[],
  opts: CallAIStreamOptions,
): Promise<void> {
  const apiKey = requireKey(config.apiKeyEnv, modelId);
  const genAI = new GoogleGenerativeAI(apiKey);
  const systemText = messages.find((m) => m.role === "system")?.content;
  const gemini = genAI.getGenerativeModel({
    model: modelId,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
    generationConfig: { temperature: opts.temperature ?? 0.3 },
    ...(systemText ? { systemInstruction: systemText } : {}),
  });

  const contents = toGoogleContents(messages);
  const result = await gemini.generateContentStream({ contents });

  let full = "";
  for await (const chunk of result.stream) {
    const delta = chunk.text();
    if (delta) { opts.onChunk(delta); full += delta; }
  }
  opts.onDone(full);
}

/** Convert non-system AIMessages → Google SDK contents format */
function toGoogleContents(messages: AIMessage[]): { role: string; parts: { text: string }[] }[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
}

// ─── Embedding (always OpenAI) ────────────────────────────────────────────────

export async function getEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new AIError("openai", "auth", "Missing OPENAI_API_KEY required for vector embeddings.");
  }
  
  const client = new OpenAI({ apiKey });
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0]?.embedding ?? [];
}
