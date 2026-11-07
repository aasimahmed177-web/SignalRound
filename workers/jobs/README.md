# Job workers

Two job sources feed the `job_postings` table and the **Jobs** page. Neither logs in anywhere.

## 1. Startup job boards (built in, no setup)

`lib/job-boards.ts` finds a company's applicant-tracking system from links on its own website
(homepage → careers page) and reads that system's public job feed:

| ATS | Public feed |
|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs` |
| Lever | `api.lever.co/v0/postings/{token}` (and the EU host) |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{token}` |
| Workable | `www.workable.com/api/accounts/{slug}` |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{id}/postings` |
| Recruitee | `{slug}.recruitee.com/api/offers` |
| BambooHR | `{tenant}.bamboohr.com/careers/list` |

When the website links no board, it tries the company's name on Greenhouse, Lever and Ashby and keeps
a match only if that board's own data names the company's domain (or its exact name). Patterns follow
[colophon-group/jobseek](https://github.com/colophon-group/jobseek) (MIT). A later scan marks roles a
board stopped listing as closed.

## 2. Job-site search with JobSpy

[speedyapply/JobSpy](https://github.com/speedyapply/JobSpy) (MIT) searches LinkedIn, Indeed, Naukri,
Glassdoor, Google Jobs and others without an account. It needs Python 3.10–3.13 (pandas):

```bash
uv venv --python 3.12 workers/.venv
uv pip install --python workers/.venv/bin/python -r workers/jobs/requirements.txt
```

Set `JOBSPY_PYTHON` to use a different interpreter. Sites rate-limit heavy use; keep `--results` modest.

## Commands

```bash
pnpm collect:jobs -- --limit 25 --apply                       # funded startups in the Signal Inbox
pnpm collect:jobs -- --website https://linear.app --apply      # one company
pnpm collect:jobs -- --search "backend engineer" --location Bengaluru \
  --sites linkedin,naukri,indeed --country india --hours 72 --results 30 --apply
```

Without `--apply` nothing is written. Stop `pnpm dev` first when using the embedded database, or use
the **Jobs** page instead.

## Other workers

Any script (Reddit, X, a custom crawler) can post roles to `POST /api/v1/jobs` with
`Authorization: Bearer $SIGNAL_INGEST_KEY`, using the fields in `lib/jobs.ts` (`source`,
`external_id`, `url`, `title`, `company` required). `GET /api/v1/jobs?q=&funded=1` reads them back.
