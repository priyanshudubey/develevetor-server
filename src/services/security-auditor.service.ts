/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  DevElevator  ·  Security Auditor  ·  Track 3 — Pattern Match  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Pure regex pattern matching — zero latency, no external calls.
 * Returns an array of vulnerability / code-smell tags.
 */

// ─── Pattern Definitions ──────────────────────────────────────────────────────

interface AuditRule {
  tag: string;
  description: string;
  pattern: RegExp;
}

const RULES: AuditRule[] = [
  // ── Security Vulnerabilities ────────────────────────────────────────────────
  {
    tag: "hardcoded-secret",
    description: "Possible hardcoded credentials or API key",
    pattern:
      /(?:password|secret|api[_-]?key|token|auth|private[_-]?key)\s*[:=]\s*["'`][^"'`\s]{6,}/i,
  },
  {
    tag: "dangerous-eval",
    description: "Use of eval() or new Function() — remote code execution risk",
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
  },
  {
    tag: "xss-risk",
    description: "Unsanitised HTML injection via innerHTML or dangerouslySetInnerHTML",
    pattern: /\.innerHTML\s*=|dangerouslySetInnerHTML/,
  },
  {
    tag: "sql-injection-risk",
    description: "String-concatenated SQL query — use parameterised queries",
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE).*\+\s*(?:req\.|params\.|body\.|query\.)/i,
  },
  {
    tag: "weak-random",
    description: "Math.random() used in security context — use crypto.getRandomValues()",
    pattern: /Math\.random\(\)/,
  },
  {
    tag: "path-traversal-risk",
    description: "User input used directly in file-path construction",
    pattern: /(?:join|resolve)\s*\([^)]*(?:req\.|params\.|body\.|query\.)/,
  },
  {
    tag: "disabled-ssl",
    description: "TLS certificate verification deliberately bypassed",
    pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/,
  },

  // ── Code Smells ─────────────────────────────────────────────────────────────
  {
    tag: "tech-debt",
    description: "TODO / FIXME / HACK comment found",
    pattern: /\b(?:TODO|FIXME|HACK|XXX|TEMP)\b/,
  },
  {
    tag: "console-log-leak",
    description: "console.log left in production code",
    pattern: /console\.log\s*\(/,
  },
  {
    tag: "empty-catch",
    description: "Empty catch block swallows errors silently",
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
  },
  {
    tag: "magic-number",
    description: "Unexplained numeric literal (magic number) in logic",
    pattern: /(?<![.[\w])(?<!0x)(?:\d{4,}|\b(?!0\b|1\b|2\b|10\b)\d{2,}\b)(?!\s*[px%ms])/,
  },
  {
    tag: "any-type-escape",
    description: "Explicit `any` type disables TypeScript safety",
    pattern: /:\s*any\b|as\s+any\b/,
  },
];

// ─── Long Method Detection ────────────────────────────────────────────────────

const FUNCTION_HEADER = /(?:function\s+\w+|=>\s*\{|\w+\s*\([^)]*\)\s*\{)/g;
const MAX_METHOD_LINES = 60;

function detectLongMethods(content: string): boolean {
  const lines = content.split("\n");
  let depth = 0;
  let methodStart: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Crude but fast — look for function openers
    if (FUNCTION_HEADER.test(line) && depth === 0) {
      methodStart = i;
      depth = 1;
      FUNCTION_HEADER.lastIndex = 0;
      continue;
    }
    FUNCTION_HEADER.lastIndex = 0;

    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0 && methodStart !== null) {
          if (i - methodStart > MAX_METHOD_LINES) return true;
          methodStart = null;
        }
      }
    }
  }
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SecurityReport {
  tags: string[];
  findings: { tag: string; description: string }[];
}

export function auditFile(content: string, filePath: string): SecurityReport {
  const tags: string[] = [];
  const findings: { tag: string; description: string }[] = [];

  for (const rule of RULES) {
    if (rule.pattern.test(content)) {
      tags.push(rule.tag);
      findings.push({ tag: rule.tag, description: rule.description });
    }
  }

  if (detectLongMethods(content)) {
    tags.push("long-method");
    findings.push({ tag: "long-method", description: `Function exceeds ${MAX_METHOD_LINES} lines` });
  }

  return { tags, findings };
}
