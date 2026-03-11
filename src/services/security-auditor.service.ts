/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  DevElevator  ·  Security Auditor  ·   3-Stage Trust Pipeline    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Stage 1: Native TypeScript AST Parser (Zero Regex)
 * Stage 2: Context Filtering (Scrub test/mock data)
 * Stage 3: AI Red Team Verification (Zero False Positives)
 */

import * as ts from "typescript";
import { callAI, DEFAULT_MODEL } from "./ai.service";
import { logger } from "../config/logger";

export interface SecurityReport {
  tags: string[];
  findings: { tag: string; description: string }[];
}

interface SuspiciousSnippet {
  tag: string;
  description: string;
  codeSnippet: string;
}

// ─── STAGE 1 & 2: AST PARSER & CONTEXT FILTER ─────────────────────────────

function extractSnippet(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line: startLine } = ts.getLineAndCharacterOfPosition(
    sourceFile,
    node.getStart(),
  );
  const { line: endLine } = ts.getLineAndCharacterOfPosition(
    sourceFile,
    node.getEnd(),
  );

  const lines = sourceFile.text.split("\n");
  const snippetStart = Math.max(0, startLine - 2);
  const snippetEnd = Math.min(lines.length - 1, endLine + 2);

  return lines.slice(snippetStart, snippetEnd + 1).join("\n");
}

export async function auditFile(
  content: string,
  filePath: string,
): Promise<SecurityReport> {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
  );

  const isTestFile = /test|\.spec\.|__tests__|mock/i.test(filePath);
  const suspiciousSnippets: SuspiciousSnippet[] = [];

  function visit(node: ts.Node) {
    // 1. Detect CallExpressions (eval, Math.random, console.log)
    if (ts.isCallExpression(node)) {
      const exp = node.expression;
      let isEval = false;
      let isMathRandom = false;
      let isConsoleLog = false;

      if (ts.isIdentifier(exp) && exp.text === "eval") {
        isEval = true;
      } else if (ts.isPropertyAccessExpression(exp)) {
        const leftSide = exp.expression.getText(sourceFile);
        const method = exp.name.text;
        if (leftSide === "Math" && method === "random") {
          isMathRandom = true;
        } else if (leftSide === "console" && method === "log") {
          isConsoleLog = true;
        }
      }

      if (isEval) {
        suspiciousSnippets.push({
          tag: "dangerous-eval",
          description: "Use of eval() — remote code execution risk",
          codeSnippet: extractSnippet(sourceFile, node),
        });
      }
      if (isMathRandom) {
        suspiciousSnippets.push({
          tag: "weak-random",
          description:
            "Math.random() used — consider crypto.getRandomValues() in security contexts",
          codeSnippet: extractSnippet(sourceFile, node),
        });
      }
      if (isConsoleLog) {
        // Stage 2: Filter out test/mock files immediately
        if (!isTestFile) {
          suspiciousSnippets.push({
            tag: "console-log-leak",
            description: "console.log left in production code",
            codeSnippet: extractSnippet(sourceFile, node),
          });
        }
      }
    }

    // 2. Detect Property Assignments to .innerHTML
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      if (
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === "innerHTML"
      ) {
        suspiciousSnippets.push({
          tag: "xss-risk",
          description:
            "Assignment to innerHTML — unsanitized HTML injection risk",
          codeSnippet: extractSnippet(sourceFile, node),
        });
      }
    }

    // React dangerouslySetInnerHTML
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(sourceFile) === "dangerouslySetInnerHTML"
    ) {
      suspiciousSnippets.push({
        tag: "xss-risk",
        description:
          "dangerouslySetInnerHTML used — unsanitized HTML injection risk",
        codeSnippet: extractSnippet(sourceFile, node),
      });
    }

    // 3. Detect Long Methods (> 60 lines)
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node)
    ) {
      const { line: startLine } = ts.getLineAndCharacterOfPosition(
        sourceFile,
        node.getStart(),
      );
      const { line: endLine } = ts.getLineAndCharacterOfPosition(
        sourceFile,
        node.getEnd(),
      );

      if (endLine - startLine > 60) {
        const lines = sourceFile.text.split("\n");
        // Only extract the head of the function instead of the entire 100+ lines
        const snippetLimit = Math.min(lines.length - 1, startLine + 5);
        const snippet =
          lines.slice(startLine, snippetLimit).join("\n") +
          "\n... [method truncated] ...";
        
        suspiciousSnippets.push({
          tag: "long-method",
          description: `Method exceeds 60 lines (Total: ${endLine - startLine} lines)`,
          codeSnippet: snippet,
        });
      }
    }

    // 4. Hardcoded secrets (heuristic on variable declarations)
    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) {
      const name = node.name.getText(sourceFile).toLowerCase();
      if (
        name.includes("password") ||
        name.includes("secret") ||
        name.includes("api_key") ||
        name.includes("apikey") ||
        name.includes("token")
      ) {
        if (
          node.initializer &&
          ts.isStringLiteral(node.initializer) &&
          node.initializer.text.length > 5 &&
          !node.initializer.text.includes(" ")
        ) {
          // Stage 2: Filter out test/mock files immediately
          if (!isTestFile) {
            suspiciousSnippets.push({
              tag: "hardcoded-secret",
              description: "Possible hardcoded credentials or API key",
              codeSnippet: extractSnippet(sourceFile, node),
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // ─── STAGE 3: THE AI JUDGE ──────────────────────────────────────────────────

  // Explicit Short-Circuit Logic
  if (suspiciousSnippets.length === 0) {
    return { tags: [], findings: [] };
  }

  const promptObj = suspiciousSnippets.map((s, idx) => ({
    id: idx,
    tag: s.tag,
    description: s.description,
    snippet: s.codeSnippet,
  }));

  const systemPrompt = `You are a Senior Security Auditor reviewing automated SAST alerts. 
Your job is to act as the Red Team and try to PROVE these are FALSE POSITIVES. 
Look at the provided code snippets. Is the input already sanitized? Is it a safe, hardcoded execution? Are the magic strings purely configuration?
For each flagged snippet, evaluate it. Reply with a JSON array of objects strictly matching this format:
[
  { "id": <number>, "tag": "vulnerability-name", "verdict": "CONFIRMED" | "FALSE_POSITIVE", "reason": "brief explanation" }
]
Do not output anything other than the JSON array.`;

  const userPrompt = `Evaluate these SAST alerts:\n${JSON.stringify(promptObj, null, 2)}`;

  try {
    const rawLlmText = await callAI({
      model: DEFAULT_MODEL, // DeepSeek or GPT fallback handled by ai.service
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      stream: false,
    });

    // Safe JSON parser: strips markdown and whitespace wrapper
    const cleanJson = rawLlmText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const evaluated: any[] = JSON.parse(cleanJson);

    const finalTags: string[] = [];
    const finalFindings: { tag: string; description: string }[] = [];

    for (const res of evaluated) {
      if (res.verdict === "CONFIRMED") {
        const orig = suspiciousSnippets[res.id];
        if (orig) {
          if (!finalTags.includes(orig.tag)) finalTags.push(orig.tag);
          finalFindings.push({ tag: orig.tag, description: orig.description });
        }
      }
    }

    return { tags: finalTags, findings: finalFindings };
  } catch (err) {
    logger.error("AI SAST Verification Failed:", err);
    
    // Fallback: If AI fails or JSON parsing fails, return raw findings directly to not drop flags
    const fallbackTags = Array.from(
      new Set(suspiciousSnippets.map((s) => s.tag)),
    );
    const fallbackFindings = suspiciousSnippets.map((s) => ({
      tag: s.tag,
      description: s.description,
    }));
    return { tags: fallbackTags, findings: fallbackFindings };
  }
}
