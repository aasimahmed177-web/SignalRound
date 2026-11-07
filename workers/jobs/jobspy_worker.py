"""Logged-out job-site search through JobSpy (speedyapply/JobSpy, MIT).

Reads one JSON request on stdin and writes one JSON object per posting on stdout, in SignalRound's
job contract (lib/jobs.ts). Uses no account, cookie or proxy unless the request names a proxy.
Diagnostics go to stderr so stdout stays machine-readable.

Request: {"search": str, "location": str?, "sites": [str], "hours_old": int?, "results": int?,
          "country": str?, "remote": bool?, "full_descriptions": bool?, "proxies": [str]?}
"""

from __future__ import annotations

import json
import math
import sys
from datetime import date, datetime

ALLOWED_SITES = {"linkedin", "indeed", "glassdoor", "zip_recruiter", "google", "naukri", "bayt", "bdjobs", "hellowork"}


def clean(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if hasattr(value, "item"):  # numpy scalar
        return clean(value.item())
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def salary(row) -> str | None:
    low, high = clean(row.get("min_amount")), clean(row.get("max_amount"))
    if low is None and high is None:
        return None
    currency = clean(row.get("currency")) or ""
    interval = clean(row.get("interval")) or ""
    span = f"{low:,.0f}" if low is not None else ""
    if high is not None and high != low:
        span = f"{span}–{high:,.0f}" if span else f"{high:,.0f}"
    return " ".join(part for part in (currency, span, interval) if part)


def main() -> int:
    request = json.load(sys.stdin)
    search = (request.get("search") or "").strip()
    if not search:
        print("search is required", file=sys.stderr)
        return 2
    sites = [s for s in (request.get("sites") or ["linkedin", "indeed"]) if s in ALLOWED_SITES]
    if not sites:
        print(f"no supported site; choose from {sorted(ALLOWED_SITES)}", file=sys.stderr)
        return 2

    from jobspy import scrape_jobs  # imported late so argument errors return fast

    frame = scrape_jobs(
        site_name=sites,
        search_term=search,
        google_search_term=f"{search} jobs near {request.get('location')}" if request.get("location") else f"{search} jobs",
        location=request.get("location") or None,
        results_wanted=max(1, min(int(request.get("results") or 20), 200)),
        hours_old=request.get("hours_old") or None,
        country_indeed=request.get("country") or "usa",
        is_remote=bool(request.get("remote")),
        proxies=request.get("proxies") or None,
        description_format="markdown",
        fetch_description=bool(request.get("full_descriptions")),
        verbose=0,
    )
    written = 0
    for raw in frame.to_dict(orient="records"):
        row = {key: clean(value) for key, value in raw.items()}
        url = row.get("job_url")
        title = row.get("title")
        company = row.get("company")
        if not (url and title and company):
            continue
        site = row.get("site") or "unknown"
        posting = {
            "source": f"jobspy-{site}".replace("_", "-"),
            "external_id": str(row.get("id") or url),
            "url": url,
            "title": title,
            "company": company,
            "company_website": row.get("company_url_direct") if str(row.get("company_url_direct") or "").startswith("http") else None,
            "location": row.get("location"),
            "remote": row.get("is_remote") if isinstance(row.get("is_remote"), bool) else None,
            "employment_type": row.get("job_type"),
            "salary": salary(row),
            "description": (row.get("description") or None) and row["description"][:20000],
            "posted_at": row.get("date_posted"),
            "metadata": {
                "collector": "jobspy",
                "site": site,
                "search": search,
                "apply_url": row.get("job_url_direct"),
                "company_profile_url": row.get("company_url"),
                "job_level": row.get("job_level"),
                "company_industry": row.get("company_industry"),
                "company_description": row.get("company_description"),
                "company_employees": row.get("company_num_employees"),
                # No emails here: JobSpy's `emails` column is a regex over raw HTML. lib/jobspy.ts derives
                # them from the stored description text, each with the line it is written on.
            },
        }
        posting["metadata"] = {k: v for k, v in posting["metadata"].items() if v not in (None, "", [])} | {"collector": "jobspy"}
        print(json.dumps(posting, ensure_ascii=False))
        written += 1
    print(f"jobspy: {written} posting(s) from {', '.join(sites)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
