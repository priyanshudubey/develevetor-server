/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  DevElevator  ·  Indexer Orchestrator  ·  Central Coordinator  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Coordinates all three analysis tracks per file:
 *   Track 1 — AST (always, synchronous)
 *   Track 2 — AI Summary (async, skipped if hash unchanged)
 *   Track 3 — Security Audit (always, synchronous)
 *
 * Concurrency is capped at MAX_CONCURRENT AI calls to avoid rate limits.
 */

import crypto from "crypto";
import { supabase } from "../config/supabase";
import { logger } from "../config/logger";
import { analyzeFile } from "./ast-analyzer.service";
import { summariseFile } from "./ai-summarizer.service";
import { auditFile } from "./security-auditor.service";

// ─── Config ───────────────────────────────────────────────────────────────────

/** Max concurrent DeepSeek/OpenAI calls during indexing */
const MAX_CONCURRENT = 5;

// ─── Inline async concurrency limiter (no p-limit ESM dependency) ─────────────

function createLimiter(concurrency: number) {
  let running = 0;
  const queue: (() => void)[] = [];

  const run = () => {
    while (running < concurrency && queue.length > 0) {
      running++;
      const next = queue.shift()!;
      next();
    }
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          running--;
          run();
        });
      });
      run();
    });
  };
}

// ─── File document type ───────────────────────────────────────────────────────

export interface IndexDocument {
  path: string;
  content: string;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class IndexerOrchestrator {
  /** Process all files for a project, running all three analysis tracks. */
  async processFiles(projectId: string, docs: IndexDocument[]): Promise<void> {
    logger.info(`[Orchestrator] Starting deep analysis of ${docs.length} files`, { projectId });

    const limit = createLimiter(MAX_CONCURRENT);

    // ── Stats ─────────────────────────────────────────────────────────────────
    let analyzed = 0;
    let aiSummaries = 0;
    let skippedUnchanged = 0;

    // ── Per-file pipeline ─────────────────────────────────────────────────────
    const tasks = docs.map((doc) =>
      limit(async () => {
        try {
          await this.processOneFile(projectId, doc, {
            onAnalyzed:     () => analyzed++,
            onAISummary:    () => aiSummaries++,
            onSkipped:      () => skippedUnchanged++,
          });
        } catch (err) {
          // Never let one file failure abort the whole batch
          logger.error(`[Orchestrator] Failed on ${doc.path}`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    await Promise.allSettled(tasks);

    // ── Summary log ───────────────────────────────────────────────────────────
    logger.info(
      `[Orchestrator] ✅ Indexing Complete — ` +
      `${analyzed} files analysed  |  ` +
      `${aiSummaries} AI summaries generated  |  ` +
      `${skippedUnchanged} skipped (unchanged)`,
      { projectId },
    );
  }

  // ── Single file ─────────────────────────────────────────────────────────────

  private async processOneFile(
    projectId: string,
    doc: IndexDocument,
    cb: { onAnalyzed: () => void; onAISummary: () => void; onSkipped: () => void },
  ): Promise<void> {
    const { path: filePath, content } = doc;

    // ── Compute content hash ──────────────────────────────────────────────────
    const fileHash = crypto.createHash("sha256").update(content).digest("hex");

    // ── Track 1: AST Analysis (always) ───────────────────────────────────────
    const astMetrics = analyzeFile(content, filePath);

    // ── Track 3: Security Audit (always) ─────────────────────────────────────
    const { tags: vulnerabilityTags } = await auditFile(content, filePath);

    // ── Upsert file_insights ──────────────────────────────────────────────────
    // Delete any existing row for this file first (no unique constraint on project_id+file_path)
    await supabase
      .from("file_insights")
      .delete()
      .eq("project_id", projectId)
      .eq("file_path", filePath);

    const { error: insightError } = await supabase
      .from("file_insights")
      .insert({
          project_id:            projectId,
          file_path:             filePath,
          loc:                   astMetrics.loc,
          cyclomatic_complexity: astMetrics.cyclomaticComplexity,
          max_nesting_depth:     astMetrics.maxNestingDepth,
          vulnerability_tags:    vulnerabilityTags,
          updated_at:            new Date().toISOString(),
        });

    if (insightError) {
      logger.warn(`[Orchestrator] file_insights upsert failed: ${filePath}`, {
        error: insightError.message,
      });
    }

    cb.onAnalyzed();
    logger.info(
      `[AST] ${filePath} — CC:${astMetrics.cyclomaticComplexity} Depth:${astMetrics.maxNestingDepth} LOC:${astMetrics.loc}` +
        (vulnerabilityTags.length ? ` | 🔴 ${vulnerabilityTags.join(", ")}` : ""),
    );

    // ── Track 2: AI Summary (only if hash changed) ────────────────────────────
    const { data: existing } = await supabase
      .from("file_summaries")
      .select("file_hash")
      .eq("project_id", projectId)
      .eq("file_path", filePath)
      .maybeSingle();

    if (existing?.file_hash === fileHash) {
      logger.info(`[Summarizer] ⏭ Skipped ${filePath} (unchanged)`);
      cb.onSkipped();
      return;
    }

    const summaryResult = await summariseFile(content, filePath);

    if (summaryResult.skipped) {
      logger.info(`[Summarizer] ⏭ Filtered ${filePath}: ${summaryResult.reason}`);
      return; // Don't count toward skipped-unchanged
    }

    const { error: summaryError } = await supabase
      .from("file_summaries")
      .upsert(
        {
          project_id:   projectId,
          file_path:    filePath,
          file_hash:    fileHash,
          summary_text: summaryResult.summary,
          embedding:    summaryResult.embedding,
        },
        { onConflict: "project_id,file_path" },
      );

    if (summaryError) {
      logger.warn(`[Orchestrator] file_summaries upsert failed: ${filePath}`, {
        error: summaryError.message,
      });
    } else {
      cb.onAISummary();
    }
  }
}

export const indexerOrchestrator = new IndexerOrchestrator();
