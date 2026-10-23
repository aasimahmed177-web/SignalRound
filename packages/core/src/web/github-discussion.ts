import { readPublicText } from "./transport.ts";

/** Public issue conversation only; PR review threads are a separate GitHub API. */
export async function readGitHubDiscussion(raw: string, limit = 20, read = readPublicText) {
  const url = new URL(raw);
  const match = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/(issues|pull)\/([1-9]\d{0,11})\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^https:\/\/github\.com\//i.test(raw) ||
    !match ||
    match[2] === "." ||
    match[2] === ".."
  )
    throw new Error("Supply a public https://github.com/owner/repo/issues/N or pull/N URL without credentials, query, fragment, or port.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("Choose 1–25 comments.");
  const [, owner, repo, kind, number] = match;
  const sourceURL = `https://github.com/${owner}/${repo}/${kind}/${number}`;
  const endpoint = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
  const signal = AbortSignal.timeout(20_000);
  const items: Array<{ id: number; parent: number | null; title: string; text: string; sourceURL: string; truncated: boolean }> = [];
  const errors: Array<{ id: string; error: string }> = [];
  let totalComments = 0;
  let truncated = false;
  const get = async (target: string) => {
    signal.throwIfAborted();
    const response = await read(target, {
      signal,
      timeoutMs: 8000,
      maxBytes: 1_000_000,
      headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
    });
    return JSON.parse(response.text);
  };
  const validId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
  try {
    const root = await get(endpoint);
    if (
      !root ||
      !validId(root.id) ||
      typeof root.url !== "string" ||
      root.url.toLowerCase() !== endpoint.toLowerCase() ||
      root.number !== Number(number) ||
      !Number.isSafeInteger(root.comments) ||
      root.comments < 0 ||
      (kind === "pull" && !root.pull_request)
    )
      throw new Error("Unrecognized GitHub issue response.");
    totalComments = root.comments;
    const body = typeof root.body === "string" ? root.body : "";
    const title = typeof root.title === "string" ? root.title : "";
    truncated = body.length > 15_000 || title.length > 1000;
    items.push({ id: root.id, parent: null, title: title.slice(0, 1000), text: body.slice(0, 15_000), sourceURL, truncated });
    if (totalComments > 0) {
      const comments = await get(`${endpoint}/comments?per_page=${limit}&page=1`);
      if (!Array.isArray(comments)) throw new Error("Unrecognized GitHub comments response.");
      truncated ||= comments.length > limit;
      const seen = new Set<number>();
      for (const row of comments.slice(0, limit)) {
        if (
          !row ||
          !validId(row.id) ||
          seen.has(row.id) ||
          typeof row.issue_url !== "string" ||
          row.issue_url.toLowerCase() !== endpoint.toLowerCase()
        ) {
          errors.push({ id: number, error: "Invalid or duplicate GitHub comment omitted." });
          continue;
        }
        seen.add(row.id);
        const text = typeof row.body === "string" ? row.body : "";
        const shortened = text.length > 15_000;
        truncated ||= shortened;
        items.push({
          id: row.id,
          parent: root.id,
          title: "",
          text: text.slice(0, 15_000),
          sourceURL: `${sourceURL}#issuecomment-${row.id}`,
          truncated: shortened,
        });
      }
    }
  } catch (error) {
    errors.push({ id: number, error: error instanceof Error ? error.message : String(error) });
  }
  const remainingDiscovered = Math.max(0, totalComments - Math.max(0, items.length - 1));
  return {
    status: !items.length ? "failed" : errors.length || remainingDiscovered || truncated ? "partial" : "completed",
    provider: "native:github-issues-api",
    fetchedAt: new Date().toISOString(),
    items,
    errors,
    remainingDiscovered,
    truncated,
    note: "Public issue/PR conversation sample in ascending comment ID order. Excludes pull-request reviews and inline review comments. Counts may change during reading. Statements are unverified; unauthenticated GitHub rate limits apply.",
    creditsUsed: 0,
  };
}
