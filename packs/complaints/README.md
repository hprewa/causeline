# Complaints pack

Consumer complaints about financial products and companies, from the CFPB's public complaint database as published in BigQuery
(`bigquery-public-data.cfpb_complaints.complaint_database`, 3.46 million rows, 2011-12-01 to 2023-03-23, a frozen copy). Nothing is
written to any project: the pack only reads, and queries are billed to your own project.

This pack was built by conversation with the Builder (a live agent and a simulated user; see `docs/evidence/sprint-2.md`), then
curated by hand. Its sign-off numbers come from the CFPB's own published counts, a different system from the copy it reads.

## KPIs
- **Timely response rate**: the share of complaints where the company responded on time.
- **Monetary relief rate**: the share of complaints closed with monetary relief (a signal, not a score of a company).
- **Complaint volume**: complaints received, by the day the CFPB received them.

Broken down by product and sub-product, issue and sub-issue, company, state and channel.

## Read these numbers with care
- Complaints are **not a statistical sample** of customers' experience: they count who chose to complain. A company with more
  complaints is not necessarily a worse company, and volumes move with publicity and size.
- **The data ends on 2023-02-12.** The copy was taken in March 2023, and the CFPB publishes a complaint only after the company responds
  or after 15 days, so the newest weeks were still filling in (the copy held 68% of the CFPB's count for 13 to 19 March, with the
  "timely" flag reading 100%). The pack leaves them out; asking about them stops and says what the data covers.
- Sub-product and sub-issue names are joined to their product or issue (names like "Other" repeat), so each value sits under one parent.
- Cost: a deep dive reads 12 to 19 GB of the unpartitioned table (about $0.07 to $0.11 at list price); the limit for one question is 30 GB.

## Run it
```powershell
$env:CAUSELINE_BQ_PROJECT = "<your project id>"      # needs: gcloud auth application-default login
node core/cli/dist/src/main.js eval --pack packs/complaints          # five real-data cases, about 70 GB read (about $0.40)
node scripts/complaints-signoff.mjs --verify                         # signs the KPIs off against the CFPB's published counts
```
`evals/known-gaps.md` lists two real incidents the analysis does not yet get right, with what was expected and what it said instead.
