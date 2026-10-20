/** Remove comments and the text inside quotes, in one pass, so the shape of a statement can be checked without being fooled by words inside it. */
function bare(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < sql.length && !(sql[i] === quote && sql[i + 1] !== quote)) i += sql[i] === quote ? 2 : 1;
      out += quote + quote;
    } else if (c === "`") {
      // a quoted name (BigQuery): its text is a name, not SQL
      const end = sql.indexOf("`", i + 1);
      i = end < 0 ? sql.length : end;
      out += "``";
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += " ";
    } else out += c;
  }
  return out;
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace|vacuum|reindex|analyze|trigger|begin|commit|rollback|savepoint|load_extension)\b/i;
/** What else changes or reaches outside a BigQuery project. */
const FORBIDDEN_BIGQUERY = /\b(insert|update|delete|drop|alter|create|merge|truncate|export|execute|grant|revoke|undrop)\b/i;

/**
 * The Builder runs SQL that an agent drafted, against the user's data. It may only read: one statement,
 * starting with SELECT or WITH, naming none of the verbs that change or reach outside the database. On BigQuery
 * this is the first of two checks; the second is the statement type BigQuery itself reports for a dry run.
 * Throws a plain-words error otherwise.
 */
export function assertReadOnlySelect(sql: string, dialect: "sqlite" | "bigquery" = "sqlite"): string {
  const text = bare(sql).trim().replace(/;+\s*$/, "");
  if (text === "") throw new Error("the SQL is empty");
  if (text.includes(";")) throw new Error("only one SELECT statement is allowed");
  if (!/^(select|with)\b/i.test(text)) throw new Error("the SQL must be a SELECT (or WITH ... SELECT)");
  const bad = (dialect === "bigquery" ? FORBIDDEN_BIGQUERY : FORBIDDEN).exec(text);
  if (bad) throw new Error(`the SQL may only read data; "${bad[1].toUpperCase()}" is not allowed`);
  return sql.trim().replace(/;+\s*$/, "");
}
