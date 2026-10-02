# Security

Report a vulnerability privately through [GitHub's private vulnerability reporting](https://github.com/firecrawl/fireround/security/advisories/new). Please do not open a public issue for a security problem. Include the affected route or file, the steps to reproduce, and what an attacker gains.

## Scope

- A way past `DASHBOARD_PASSWORD`, the Firecrawl webhook signature (`FIRECRAWL_WEBHOOK_SECRET`), `CRON_SECRET`, `MCP_API_KEY`, or a feed token.
- On a public instance (`PUBLIC_DEMO=1`): a visitor reaching an admin path, a write, or an action that spends Firecrawl credits, or reading rows the feed does not publish.
- Public Add to Slack: reading or changing another channel's subscription, or recovering a stored webhook without `SLACK_WEBHOOK_KEY`.

Findings about fireround.dev itself are in scope. Rate limits, missing headers with no exploit, and reports from automated scanners alone are not.
