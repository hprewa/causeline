#!/usr/bin/env node
// A guardrail, not a boundary: stops the assistant from reaching the data by a side door (a database command line, an inline script
// that opens a database, the Toolbox server's own endpoint). The data is read only through the causeline tools, which are fixed reads,
// metered and recorded. The boundary that matters is that those tools offer no free query and that the person's own database role is
// read-only; this hook catches the common ways a model might go round them, and says what to do instead.
//
// Claude Code runs it before a shell command: it reads the call as JSON on stdin and answers on stdout.
import { pathToFileURL } from "node:url";

const INSTEAD = "Read the data through the causeline tools: `explore` for a ranking, breakdown or series, or the analysis for why something changed. If the figure you need is not available, say so and offer to add it as a KPI with the Builder.";

/** Each rule: what it catches (on the command with quoted text removed, unless `quoted`), and why it is not allowed. */
export const RULES = [
  { id: "bq", re: /(^|[\s;&|(])(bq|gcloud\s+(alpha\s+)?bq)\s+(query|extract|load|mk|rm|cp|insert|head|show)\b/i, why: "the BigQuery command line queries the data directly" },
  { id: "database_cli", re: /(^|[\s;&|(])(sqlite3?|duckdb|psql|mysql|mariadb|clickhouse-client|sqlcmd|snowsql|mongosh?)(\.exe)?(\s|$)/i, why: "a database command line queries the data directly" },
  { id: "toolbox", re: /(^|[\s;&|(\\/])toolbox(\.exe)?(\s|$)/i, why: "the Toolbox server is started and called by the causeline tools, not by hand" },
  { id: "toolbox_endpoint", re: /\/api\/(tool|toolset)\b/i, why: "the Toolbox server's own endpoint runs queries without the causeline tools' limits and record" },
  { id: "database_file", re: /\.(db|sqlite3?|duckdb|parquet)\b/i, why: "a database file holds the data directly" },
  { id: "inline_code", quoted: true, re: /\b(python3?|py|node|ruby|perl|Rscript)(\.exe)?\s+(-c|-e|--eval|-r|--command)\b[^\n]*\b(sqlite3?|duckdb|bigquery|psycopg2?|pymysql|mysql|pandas\.read_sql|read_sql|\.query\(|create_engine|ToolboxClient|toolbox-sdk)\b/i, why: "an inline script that opens a database queries the data directly" },
  { id: "powershell_sql", quoted: true, re: /\b(Invoke-Sqlcmd|Invoke-SqliteQuery|System\.Data\.SqlClient|Invoke-RestMethod[^\n]*\/api\/tool)\b/i, why: "a script that queries a database queries the data directly" },
];

const stripQuoted = (c) => c.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');

/** Is this shell command a side door to the data? Pure: the same command always gets the same answer. */
export function check(command) {
  const text = String(command ?? "");
  const bare = stripQuoted(text);
  for (const rule of RULES) {
    if (rule.re.test(rule.quoted ? text : bare)) return { blocked: true, rule: rule.id, reason: `Not allowed: ${rule.why}. ${INSTEAD}` };
  }
  return { blocked: false };
}

/** What Claude Code reads back from a PreToolUse hook. */
export function decision(input) {
  const command = input?.tool_input?.command ?? input?.tool_input?.cmd ?? "";
  const r = check(command);
  return r.blocked ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.reason } } : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let input = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      // not something we can read: do not get in the way
    }
    process.stdout.write(JSON.stringify(decision(input)) + "\n");
  });
}
