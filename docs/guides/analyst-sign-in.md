# Signing in to BigQuery, and asking for access

Causeline only ever reads your data. It signs in as **you**, with your Google account, so it can see exactly what you can see and nothing more. Read-only comes from your **role**, not from anything Causeline asks Google for.

## What your administrator needs to give you

Two roles, both read-only:

| Role | Where | Why |
|---|---|---|
| BigQuery Data Viewer (`roles/bigquery.dataViewer`) | the dataset you want analysed | to read the tables |
| BigQuery Job User (`roles/bigquery.jobUser`) | the Google Cloud project that pays for the queries | to run queries |

Your assistant can write the message for you: say **"write the message to my administrator"**. It names the roles, the dataset and project, what the access does and does not allow, and the limit on what one question may read. You send it yourself.

## Signing in

On a computer where you cannot or do not want to use a terminal, your administrator or an engineer signs in once with Google's own tool (`gcloud auth application-default login`), and Causeline uses that sign-in. Causeline never sees or stores your password.

**If it says your sign-in has expired:** sign in again. Some organisations require everyone to sign in again every few days. That is Google's policy for the account, not a fault in Causeline.

## What the messages mean

| Causeline says | What to do |
|---|---|
| No Google sign-in was found | Sign in with Google first. |
| Sign-in has expired | Sign in again. |
| Not allowed to run queries on the project | Ask for BigQuery Job User on the project that pays. |
| Not allowed to read this data | Ask the data owner for BigQuery Data Viewer on the dataset. |
| Project or dataset not found | Check the name with whoever gave it to you. |
| Billing or quota | Ask whoever manages the project. |

## For an administrator who wants to avoid the terminal

A shared "Sign in with Google" button would need Google's review of the app (a verified domain, a privacy policy and a recorded demo, typically 3 to 5 business days) and would be asking for wider permissions than the read-only promise. The alternative that needs no review is an **OAuth client created in your own Google Cloud project** (a "desktop app" client). **Causeline does not use one yet**; this is the planned route for people who cannot use the terminal, and it is not built. Until it is, the terminal sign-in above is the only way.
