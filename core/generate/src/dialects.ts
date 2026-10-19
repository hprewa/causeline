import type { DialectName } from "@causeline/schema";
import { bigquery } from "./bigquery.js";
import type { Dialect } from "./dialect.js";
import { sqlite } from "./sqlite.js";

const ALL: Record<DialectName, Dialect> = { sqlite, bigquery };

/** The dialect a data definition asks for. */
export const dialectOf = (name: DialectName): Dialect => ALL[name];
