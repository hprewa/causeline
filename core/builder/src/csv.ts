/** A small RFC 4180 reader: quotes, escaped quotes, CRLF, a leading BOM. Returns the header and the rows. */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  const [header = [], ...body] = rows;
  return { header: header.map((h) => h.trim()), rows: body };
}

export type ColumnType = "integer" | "real" | "text" | "date" | "datetime";

export interface Inferred {
  type: ColumnType;
  /** Converts a raw cell to what is stored (numbers as numbers, dates as ISO text, empty as null). */
  convert: (raw: string) => string | number | null;
  /** Something a person should know: a guess, or a date format that could not be read. */
  note?: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const SLASH_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const INT = /^-?\d+$/;
const REAL = /^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;
const p2 = (n: number | string) => String(n).padStart(2, "0");

/** Work out a column's type from all of its values, never from the first few. */
export function inferColumn(values: string[]): Inferred {
  const present = values.map((v) => v.trim()).filter((v) => v !== "");
  const asNull = (v: string) => (v.trim() === "" ? null : undefined);
  if (present.length === 0) return { type: "text", convert: (v) => asNull(v) ?? v };

  if (present.every((v) => INT.test(v) && !(v.length > 1 && v.startsWith("0")) && v.length < 16)) {
    return { type: "integer", convert: (v) => asNull(v) ?? Number(v.trim()) };
  }
  if (present.every((v) => REAL.test(v) && !(v.length > 1 && v.startsWith("0") && !v.startsWith("0.")))) {
    return { type: "real", convert: (v) => asNull(v) ?? Number(v.trim()) };
  }
  if (present.every((v) => ISO_DATE.test(v))) return { type: "date", convert: (v) => asNull(v) ?? v.trim() };
  if (present.every((v) => ISO_DATETIME.test(v))) {
    return {
      type: "datetime",
      convert: (v) => {
        const m = ISO_DATETIME.exec(v.trim());
        return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? "00"}` : null;
      },
    };
  }
  if (present.every((v) => SLASH_DATE.test(v))) {
    // day first or month first is decided by the data: a first part above 12 can only be a day, and the reverse
    const parts = present.map((v) => SLASH_DATE.exec(v)!);
    const dayFirst = parts.some((m) => Number(m[1]) > 12);
    const monthFirst = parts.some((m) => Number(m[2]) > 12);
    if (dayFirst === monthFirst) {
      return { type: "text", convert: (v) => asNull(v) ?? v, note: "looks like a date written as 01/02/2026, but day-first or month-first cannot be told from the values; left as text until you say which" };
    }
    const hasTime = parts.some((m) => m[4] !== undefined);
    return {
      type: hasTime ? "datetime" : "date",
      note: `read as ${dayFirst ? "day/month/year" : "month/day/year"} from the values`,
      convert: (v) => {
        const m = SLASH_DATE.exec(v.trim());
        if (!m) return null;
        const [d, mo] = dayFirst ? [m[1], m[2]] : [m[2], m[1]];
        const date = `${m[3]}-${p2(mo)}-${p2(d)}`;
        return hasTime ? `${date} ${p2(m[4] ?? 0)}:${m[5] ?? "00"}:${m[6] ?? "00"}` : date;
      },
    };
  }
  return { type: "text", convert: (v) => asNull(v) ?? v };
}

/** A column or table name as a plain identifier: lower case, letters, digits and underscores. */
export function slug(name: string): string {
  const s = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(s) ? s : `c_${s}`;
}
