/**
 * Turns what Google's libraries throw into a sentence a person can act on. The raw message is kept after the
 * sentence for anyone who needs it.
 */
export function explainBigQueryError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const text = raw.toLowerCase();
  const withRaw = (sentence: string) => `${sentence} (${raw.split("\n")[0].slice(0, 200)})`;
  if (text.includes("invalid_grant") || text.includes("reauth") || text.includes("token has been expired")) {
    return withRaw("Your Google sign-in has expired. Sign in again, then retry.");
  }
  if (text.includes("default credentials")) {
    return withRaw("No Google sign-in was found on this computer. Sign in with Google first.");
  }
  if (text.includes("not found: dataset") || (text.includes("dataset") && text.includes("not found"))) {
    return withRaw("That dataset does not exist in this project. Check its name, or create it first.");
  }
  if (text.includes("not found: table") || (text.includes("table") && text.includes("not found"))) {
    return withRaw("A table the analysis needs is missing from that dataset.");
  }
  if (text.includes("access denied") || text.includes("permission") || text.includes("403")) {
    return withRaw("This Google account is not allowed to read that data. Ask the data owner for read access, or use another account.");
  }
  if (text.includes("billing") || text.includes("quota")) {
    return withRaw("BigQuery refused the query because of billing or quota on the project.");
  }
  if (text.includes("project") && (text.includes("not found") || text.includes("invalid"))) {
    return withRaw("That Google Cloud project could not be found. Check its id.");
  }
  return withRaw("BigQuery reported a problem.");
}
