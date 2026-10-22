import { test } from "node:test";
import assert from "node:assert/strict";
import { accessAdvice, accessMessage, classifyBigQueryError, explainBigQueryError } from "../src/index.js";

const err = (m: string) => new Error(m);

test("Google's errors are told apart by what to do about them", () => {
  assert.equal(classifyBigQueryError(err("invalid_grant: Bad Request")), "expired");
  assert.equal(classifyBigQueryError(err("reauth related error (invalid_rapt)")), "expired");
  assert.equal(classifyBigQueryError(err("Could not load the default credentials.")), "not_signed_in");
  assert.equal(classifyBigQueryError(err("Access Denied: Project p: User does not have bigquery.jobs.create permission in project p.")), "cannot_run_queries");
  assert.equal(classifyBigQueryError(err("Access Denied: Table a:b.c: User does not have bigquery.tables.getData permission for table a:b.c.")), "cannot_read_data");
  assert.equal(classifyBigQueryError(err("Access Denied: Dataset a:b: Permission bigquery.datasets.get denied")), "cannot_read_data");
  assert.equal(classifyBigQueryError(err("403 Forbidden")), "no_permission");
  assert.equal(classifyBigQueryError(err("Not found: Dataset p:nope")), "dataset_missing");
  assert.equal(classifyBigQueryError(err("Not found: Table p:d.t")), "table_missing");
  assert.equal(classifyBigQueryError(err("Project nonsense not found")), "project_not_found");
  assert.equal(classifyBigQueryError(err("Quota exceeded")), "billing");
  assert.equal(classifyBigQueryError(err("something odd")), "other");
});

test("the messages people already see keep their words, and an expiry says it is the organisation's policy", () => {
  assert.match(explainBigQueryError(err("invalid_grant")), /sign-in has expired/);
  assert.match(explainBigQueryError(err("invalid_grant")), /Google's policy, not a fault/);
  assert.match(explainBigQueryError(err("Access Denied: x")), /not allowed to read/);
  for (const p of ["not_signed_in", "expired", "cannot_run_queries", "cannot_read_data", "no_permission", "project_not_found", "dataset_missing", "table_missing", "billing", "other"] as const) {
    assert.ok(accessAdvice(p).length > 20, p);
  }
  assert.match(accessAdvice("cannot_run_queries"), /Job User/);
  assert.match(accessAdvice("cannot_read_data"), /Data Viewer/);
});

test("the message to an administrator names both roles and where, what the access cannot do, and the limit", () => {
  const m = accessMessage({ project: "my-billing", dataset: "bigquery-public-data.cfpb_complaints", account: "ana@example.com", cap_gb: 20 });
  assert.deepEqual(m.needs.map((n) => n.id), ["roles/bigquery.dataViewer", "roles/bigquery.jobUser"]);
  assert.match(m.message, /BigQuery Data Viewer \(roles\/bigquery\.dataViewer\) on the dataset bigquery-public-data\.cfpb_complaints/);
  assert.match(m.message, /BigQuery Job User \(roles\/bigquery\.jobUser\) on the project my-billing/);
  assert.match(m.message, /ana@example\.com/);
  assert.match(m.message, /Nothing can be written, changed or deleted/);
  assert.match(m.message, /up to 20 GB/);
  assert.match(m.message, /billed to my-billing/);
  assert.doesNotMatch(m.message, /OAuth|scope|token/i);
});

test("only the missing role is asked for, an unknown dataset is said so, and a message without a project is refused", () => {
  assert.deepEqual(accessMessage({ project: "p", dataset: "d", problem: "cannot_run_queries" }).needs.map((n) => n.id), ["roles/bigquery.jobUser"]);
  assert.deepEqual(accessMessage({ project: "p", dataset: "d", problem: "cannot_read_data" }).needs.map((n) => n.id), ["roles/bigquery.dataViewer"]);
  assert.match(accessMessage({ project: "p" }).message, /I will tell you which/);
  assert.match(accessMessage({ project: "p" }).message, /standard limit/);
  assert.throws(() => accessMessage({ project: " " }), /project/);
});
