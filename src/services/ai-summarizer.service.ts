/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  DevElevator  ·  AI Summarizer  ·  Track 2 — Semantic          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Generates a one-sentence semantic summary of a source file via
 * DeepSeek-V3, then embeds it for RAG retrieval.
 *
 * Guards:
 *  - Only runs on recognised code/doc file types
 *  - Truncates files > MAX_FILE_CHARS to avoid token waste
 *  - Caller is responsible for the hash-change check
 */

import { callAI, getEmbedding } from "./ai.service";
import { logger } from "../config/logger";

// ─── Config ───────────────────────────────────────────────────────────────────

/** Hard limit: files larger than this are truncated before summarisation */
const MAX_FILE_CHARS = 20_000; // ~5 000 tokens — well within DeepSeek 64K window

/** Only these extensions are worth summarising */
const SUMMARISABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".cpp", ".c", ".cs",
  ".rb", ".php", ".swift", ".kt",
  ".md", ".mdx",
]);

/** Files matching these patterns are always skipped */
const SKIP_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,                    // Jest snapshots
  /node_modules/,
  /dist\//,
  /build\//,
  /\.d\.ts$/,                   // Declaration files — no logic to summarise
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shouldSummarise(filePath: string): boolean {
  // Check ignore patterns first
  if (SKIP_PATTERNS.some((p) => p.test(filePath))) return false;
  // Then check extension whitelist
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return SUMMARISABLE_EXTENSIONS.has(ext);
}

function truncate(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_FILE_CHARS) return { text: content, truncated: false };
  // Keep first MAX_FILE_CHARS chars — these contain imports, exports, class defs
  return { text: content.slice(0, MAX_FILE_CHARS), truncated: true };
}

// ─── Core ─────────────────────────────────────────────────────────────────────

export interface SummaryResult {
  summary: string;
  embedding: number[];
  skipped: boolean;
  reason?: string;
}

const SYSTEM_PROMPT = `You are a senior software engineer performing code analysis.
Produce exactly ONE sentence that describes what the following source file does,
focusing on its primary purpose, main exports, and key side-effects if any.
Do NOT include file name or language. Do NOT use bullet points or headings.
Respond with the one-sentence summary ONLY.`;

export async function summariseFile(
  content: string,
  filePath: string,
): Promise<SummaryResult> {
  // ── Filter check ──────────────────────────────────────────────────────────
  if (!shouldSummarise(filePath)) {
    return { summary: "", embedding: [], skipped: true, reason: "filtered-extension" };
  }

  if (content.trim().length === 0) {
    return { summary: "", embedding: [], skipped: true, reason: "empty-file" };
  }

  // ── Truncation ────────────────────────────────────────────────────────────
  const { text, truncated } = truncate(content);
  if (truncated) {
    logger.info(`[Summarizer] Truncated ${filePath} (${content.length} → ${MAX_FILE_CHARS} chars)`);
  }

  // ── DeepSeek summary ─────────────────────────────────────────────────────
  const summary = await callAI({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: `\`\`\`\n${text}\n\`\`\`` },
    ],
    temperature: 0.2,
    stream: false,
  });

  // ── Embedding ─────────────────────────────────────────────────────────────
  // We embed the summary (not the raw code) — small vector, high signal-to-noise
  const embedding = await getEmbedding(summary);

  logger.info(`[Summarizer] ✓ ${filePath} — "${summary.slice(0, 80)}…"`);

  return { summary, embedding, skipped: false };
}
