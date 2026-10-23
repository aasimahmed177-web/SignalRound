import { describe, expect, it, vi } from "vitest";
import { readDiscussion } from "./discussion.ts";
import { readGitHubDiscussion } from "./github-discussion.ts";
import type { PublicText } from "./transport.ts";

const url = "https://github.com/owner/repo/issues/12";
const endpoint = "https://api.github.com/repos/owner/repo/issues/12";
const root = { id: 100, number: 12, url: endpoint, title: "Issue", body: "Details", comments: 1 };
const comment = { id: 200, body: "Reply", issue_url: endpoint, html_url: "https://evil.example" };
const response = (data: unknown): PublicText => ({
  text: JSON.stringify(data),
  url: endpoint,
  status: 200,
  contentType: "application/json",
});
const reader = (issue = root, comments: unknown = [comment]) =>
  vi.fn().mockResolvedValueOnce(response(issue)).mockResolvedValueOnce(response(comments));

describe("public GitHub discussions", () => {
  it("dispatches through Discussion, pins API endpoints and constructs evidence URLs", async () => {
    const read = reader();
    const result = await readDiscussion(url, 3, read);
    expect(result.status).toBe("completed");
    expect(result.items.map((item) => item.sourceURL)).toEqual([url, `${url}#issuecomment-200`]);
    expect(result.items[1].parent).toBe(100);
    expect(read.mock.calls.map(([target]) => target)).toEqual([endpoint, `${endpoint}/comments?per_page=3&page=1`]);
    expect(read.mock.calls[0][1]).toMatchObject({ timeoutMs: 8000, maxBytes: 1_000_000 });
    expect(read.mock.calls[0][1].signal).toBe(read.mock.calls[1][1].signal);
    expect(read.mock.calls[0][1].headers).not.toHaveProperty("authorization");
  });

  it.each([
    "http://github.com/owner/repo/issues/12",
    "https://github.com:443/owner/repo/issues/12",
    "https://u:p@github.com/owner/repo/issues/12",
    `${url}?token=secret`,
    `${url}#issuecomment-200`,
    "https://github.com/owner/repo/discussions/12",
    "https://github.com/owner/repo/issues/0",
    "https://github.com.evil.example/owner/repo/issues/12",
    "https://github.com/owner%2frepo/repo/issues/12",
  ])("rejects unsupported target %s before reading", async (target) => {
    const read = reader();
    await expect(readGitHubDiscussion(target, 2, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, 26, 1.2, Number.NaN])("rejects invalid limit %s", async (limit) => {
    const read = reader();
    await expect(readGitHubDiscussion(url, limit, read)).rejects.toThrow("1–25");
    expect(read).not.toHaveBeenCalled();
  });

  it("returns explicit partial samples and never follows pagination or response URLs", async () => {
    const read = reader({ ...root, comments: 10 });
    const result = await readGitHubDiscussion(url, 1, read);
    expect(result).toMatchObject({ status: "partial", remainingDiscovered: 9 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("marks shortened text as partial", async () => {
    const result = await readGitHubDiscussion(url, 1, reader({ ...root, comments: 0, body: "x".repeat(16000) }));
    expect(result).toMatchObject({ status: "partial", truncated: true });
    expect(result.items[0].text).toHaveLength(15000);
  });

  it("accepts public PR conversations but explains excluded review threads", async () => {
    const result = await readGitHubDiscussion(url.replace("issues", "pull"), 1, reader({ ...root, pull_request: {} } as typeof root));
    expect(result.status).toBe("completed");
    expect(result.note).toContain("Excludes pull-request reviews");
  });

  it("validates root identities and does not read comments after invalid root", async () => {
    const read = reader({ ...root, number: 13 });
    expect((await readGitHubDiscussion(url, 1, read)).status).toBe("failed");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("omits malformed, cross-thread and duplicate comment IDs", async () => {
    const result = await readGitHubDiscussion(
      url,
      5,
      reader({ ...root, comments: 5 }, [
        comment,
        comment,
        { ...comment, id: -1 },
        { ...comment, id: 201, issue_url: "https://evil.example" },
        null,
      ]),
    );
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(2);
    expect(result.errors).toHaveLength(4);
  });

  it("preserves root when comments fail or rate limit", async () => {
    const read = vi.fn().mockResolvedValueOnce(response(root)).mockRejectedValueOnce(new Error("HTTP 403 reading api.github.com"));
    const result = await readGitHubDiscussion(url, 1, read);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(result.errors[0].error).toContain("403");
  });
});
