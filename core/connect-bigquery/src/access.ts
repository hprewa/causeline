import { DEFAULT_BUDGET_GB } from "./meter.js";
import { sayCap } from "./cost.js";
import type { AccessProblem } from "./explain.js";

export const ROLE_READ = { name: "BigQuery Data Viewer", id: "roles/bigquery.dataViewer" };
export const ROLE_RUN = { name: "BigQuery Job User", id: "roles/bigquery.jobUser" };

export interface AccessRequest {
  /** The project queries are billed to (the person's own). */
  project: string;
  /** The data to read: `project.dataset` or `dataset`, when known. */
  dataset?: string;
  /** The Google account that signs in, when the person knows it. */
  account?: string;
  /** The most one question may read, in GB; omitted means the standard limit. */
  cap_gb?: number;
  /** Which part failed, to say which role is missing; omitted asks for both. */
  problem?: AccessProblem;
}

export interface AccessMessage {
  /** A message the person can send as it is. */
  message: string;
  /** The same needs as a short list, for the assistant to explain. */
  needs: { role: string; id: string; on: string }[];
}

/**
 * The message to send to whoever looks after the data. Read-only comes from the role the person holds, not from anything Causeline asks Google
 * for, so the roles are named exactly: one to read the dataset, one to run queries on the project that pays.
 */
export function accessMessage(req: AccessRequest): AccessMessage {
  if (!req.project.trim()) throw new Error("the Google Cloud project that queries are billed to is needed to write this message");
  const who = req.account?.trim() || "my Google account";
  const where = req.dataset?.trim() ? `the dataset ${req.dataset.trim()}` : "the dataset I will be analysing (I will tell you which)";
  const needs: AccessMessage["needs"] = [];
  const wantRead = req.problem !== "cannot_run_queries";
  const wantRun = req.problem !== "cannot_read_data";
  if (wantRead) needs.push({ role: ROLE_READ.name, id: ROLE_READ.id, on: where });
  if (wantRun) needs.push({ role: ROLE_RUN.name, id: ROLE_RUN.id, on: `the project ${req.project.trim()}` });
  const lines = needs.map((n, i) => `${i + 1}. ${n.role} (${n.id}) on ${n.on}`);
  const message = [
    "Hello,",
    "",
    `I am setting up Causeline, a tool that finds the causes behind changes in a business number, on ${where.replace("the dataset I will be analysing (I will tell you which)", "our data")}. Could you give ${who} read-only access:`,
    "",
    ...lines,
    "",
    "What this allows, and what it does not:",
    "- Reading the data and running queries. Nothing can be written, changed or deleted with these roles.",
    `- Each question is limited in what it reads: ${sayCap(req.cap_gb ?? DEFAULT_BUDGET_GB, req.cap_gb === undefined ? "default" : "chosen")}`,
    `- The queries are billed to ${req.project.trim()}.`,
    "",
    "To check it worked, I will sign in with Google and run a small test query; I will tell you if it fails.",
    "",
    "Thank you.",
  ].join("\n");
  return { message, needs };
}

/** What a person should do next about a problem, in a sentence; an administrator's help is named where it applies. */
export function accessAdvice(problem: AccessProblem): string {
  switch (problem) {
    case "not_signed_in":
      return "Sign in with your Google account on this computer first.";
    case "expired":
      return "Sign in with Google again. Some organisations require this every few days; it is Google's policy.";
    case "cannot_run_queries":
      return "Your account may read the data but is not allowed to run queries on the project that pays for them. Ask your administrator for the BigQuery Job User role on that project (access_help writes the message).";
    case "cannot_read_data":
      return "Your account can run queries but is not allowed to read this data. Ask the data owner for the BigQuery Data Viewer role on the dataset (access_help writes the message).";
    case "no_permission":
      return "Your account is not allowed to do this. Ask your administrator for read access (access_help writes the message).";
    case "project_not_found":
      return "That Google Cloud project could not be found. Check its id; it is the project your queries are billed to.";
    case "dataset_missing":
      return "That dataset does not exist in this project. Check its name.";
    case "table_missing":
      return "A table the analysis needs is missing from that dataset.";
    case "billing":
      return "BigQuery refused because of billing or quota on the project. Ask whoever manages the project.";
    default:
      return "BigQuery reported a problem; the detail is in the line above.";
  }
}
