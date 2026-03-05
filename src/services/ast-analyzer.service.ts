/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  DevElevator  ·  AST Analyzer  ·  Track 1 — Deterministic      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Uses acorn (lightweight JS/TS tokenizer) to analyse structural
 * metrics without counting braces inside string literals or comments.
 *
 * Supported: .js  .jsx  .ts  .tsx
 * Fallback:  all other text files get a regex-based estimate
 */

import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { logger } from "../config/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ASTMetrics {
  loc: number;
  cyclomaticComplexity: number;
  maxNestingDepth: number;
}

// ─── Decision-point node types (each +1 to CC) ───────────────────────────────

const DECISION_NODES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchCase",
  "ConditionalExpression",    // ternary
  "LogicalExpression",        // && || ??
  "TryStatement",
  "CatchClause",
  "OptionalMemberExpression",
  "OptionalCallExpression",
]);

// ─── AST-based analysis (JS / TS files) ──────────────────────────────────────

function analyzeWithAST(content: string): ASTMetrics {
  const loc = content.split("\n").filter((l) => l.trim().length > 0).length;

  let ast: acorn.Node;
  try {
    ast = acorn.parse(content, {
      ecmaVersion: "latest" as any,
      sourceType: "module",
      allowHashBang: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowReserved: true,
    });
  } catch {
    // TypeScript-only syntax can trip acorn — fall back gracefully
    return fallbackMetrics(content);
  }

  // ── Cyclomatic Complexity ─────────────────────────────────────────────────
  let cyclomaticComplexity = 1; // baseline

  walk.simple(ast as any, {
    IfStatement:             () => cyclomaticComplexity++,
    ForStatement:            () => cyclomaticComplexity++,
    ForInStatement:          () => cyclomaticComplexity++,
    ForOfStatement:          () => cyclomaticComplexity++,
    WhileStatement:          () => cyclomaticComplexity++,
    DoWhileStatement:        () => cyclomaticComplexity++,
    SwitchCase:              () => cyclomaticComplexity++,
    ConditionalExpression:   () => cyclomaticComplexity++,
    LogicalExpression: (node: any) => {
      if (node.operator === "&&" || node.operator === "||" || node.operator === "??") {
        cyclomaticComplexity++;
      }
    },
    CatchClause: () => cyclomaticComplexity++,
  });

  // ── Max Nesting Depth ─────────────────────────────────────────────────────
  // Walk the token stream: track depth only on block-boundary nodes
  let currentDepth = 0;
  let maxNestingDepth = 0;

  const BLOCK_OPENERS = new Set([
    "BlockStatement", "FunctionDeclaration", "FunctionExpression",
    "ArrowFunctionExpression", "ClassBody",
    "IfStatement", "ForStatement", "ForInStatement", "ForOfStatement",
    "WhileStatement", "DoWhileStatement", "TryStatement", "SwitchStatement",
  ]);

  // Use a simple recursive visitor tracking depth
  function visitDepth(node: any, depth: number) {
    if (!node || typeof node.type !== "string") return;
    maxNestingDepth = Math.max(maxNestingDepth, depth);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach((c) => {
          if (c && typeof c.type === "string") {
            visitDepth(c, BLOCK_OPENERS.has(c.type) ? depth + 1 : depth);
          }
        });
      } else if (child && typeof child.type === "string") {
        visitDepth(child, BLOCK_OPENERS.has(child.type) ? depth + 1 : depth);
      }
    }
  }

  visitDepth(ast, 0);

  return { loc, cyclomaticComplexity, maxNestingDepth };
}

// ─── Fallback: regex-with-comment-stripping (non-JS files) ───────────────────

function fallbackMetrics(content: string): ASTMetrics {
  // Strip block comments, line comments, and string literals before counting
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''")
    .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, "``");

  const loc = content.split("\n").filter((l) => l.trim().length > 0).length;

  const decisionPattern =
    /\b(if|else if|for|while|do|switch|case|catch)\b|&&|\|\||\?\./g;
  const cyclomaticComplexity = 1 + (stripped.match(decisionPattern)?.length ?? 0);

  // Count nesting depth by cursor-walking stripped braces
  let depth = 0;
  let maxNestingDepth = 0;
  for (const ch of stripped) {
    if (ch === "{") { depth++; maxNestingDepth = Math.max(maxNestingDepth, depth); }
    else if (ch === "}") { depth = Math.max(0, depth - 1); }
  }

  return { loc, cyclomaticComplexity, maxNestingDepth };
}

// ─── Public API ───────────────────────────────────────────────────────────────

const JS_LIKE = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

export function analyzeFile(content: string, filePath: string): ASTMetrics {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  try {
    if (JS_LIKE.has(ext)) return analyzeWithAST(content);
    return fallbackMetrics(content);
  } catch (err) {
    logger.warn(`[AST] Analysis failed for ${filePath}, returning defaults`, { err });
    return { loc: 0, cyclomaticComplexity: 1, maxNestingDepth: 0 };
  }
}
