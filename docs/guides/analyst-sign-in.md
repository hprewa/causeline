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

## Signing in without a terminal (needs a file from your administrator, once)

Say **"sign me in to Google"**. Your assistant opens Google's own sign-in page in your browser; you choose your account and allow read access; you tell the assistant you are done. Causeline keeps the lasting sign-in in its own folder and uses it from then on. Your password is typed on Google's page and never reaches Causeline or your assistant. If you already use Google's terminal tool, that sign-in is not touched.

The first time, Causeline needs a small **sign-in file** that your administrator makes once for the whole team. It holds no password and no person's data.

## For an administrator: making the sign-in file

A shared "Sign in with Google" button would need Google's review of the app (a verified domain, a privacy policy and a recorded demo, typically 3 to 5 business days). A sign-in file made **in your own Google Cloud project** needs no review. About five minutes, in the Google Cloud console of the project that pays for the queries:

1. **APIs and services, OAuth consent screen.** If your organisation uses Google Workspace, choose user type **Internal**: only your own people can sign in, there is no review, and the sign-in does not expire every week. Otherwise choose **External** and leave it in **Testing**, then add each analyst under **Test users** (Google limits testing sign-ins to 100 people and makes them sign in again every 7 days, and shows an "unverified app" notice; that is Google's rule for apps that have not been reviewed).
2. **Data access (scopes):** add `https://www.googleapis.com/auth/bigquery` only. Read-only comes from the roles in the table above, not from this.
3. **APIs and services, Credentials, Create credentials, OAuth client ID.** Application type **Desktop app**; any name (for example "Causeline").
4. **Download the JSON** for that client and give the file to each analyst (a shared drive or an email is fine: it is not a secret in the way a password is, and it cannot sign anyone in on its own).
5. Give each analyst the two roles in the first table.

If sign-in fails with "access blocked" or "this app is not verified" on Google's page: the person is not on the test-user list (External) or is outside the organisation (Internal). Add them, or use the terminal sign-in.
