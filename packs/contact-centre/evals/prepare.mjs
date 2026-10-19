// Builds a self-contained contact-centre pack for one eval case. The steps are the shared ones in
// packs/_lib; this pack follows the convention they describe (data/generate.py, then data/load.sql for SQLite
// or data/bigquery.json for BigQuery). CAUSELINE_TARGET=bigquery picks BigQuery.
import { prepareSynthetic } from "../../_lib/synthetic-prepare.mjs";
import { prepareSyntheticBigQuery } from "../../_lib/bigquery-prepare.mjs";

export default (args) => (process.env.CAUSELINE_TARGET === "bigquery" ? prepareSyntheticBigQuery(args) : prepareSynthetic(args));
