import { afterEach, describe, expect, test, vi } from "vitest";
import { NativeWebClient } from "./client.ts";
import type { PublicText, ReadPublicOptions } from "./transport.ts";

const root = "https://example.org/";
const sitemap = `${root}sitemap.xml`;
const response = (url: string, text: string): PublicText => ({ url, text, status: 200, contentType: "text/xml" });
const urlset = (urls: string[]) => `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;

afterEach(() => vi.useRealTimers());

describe("native website mapping", () => {
  test.each(["failed", "empty"])("discovers sitemap links when homepage is %s", async (kind) => {
    const client = new NativeWebClient({
      read: async (url) => {
        if (url === root && kind === "failed") throw new Error("Homepage unavailable");
        return response(url, url === root ? "<html><body></body></html>" : urlset([`${root}funding`]));
      },
    });
    const result = await client.map(root);
    expect(result.links).toEqual([{ url: `${root}funding` }]);
    expect(result.sources).toContainEqual({ url: sitemap, kind: "sitemap" });
    expect(result.partial).toBe(kind === "failed");
    expect(result.errors.length).toBe(kind === "failed" ? 1 : 0);
  });

  test("keeps homepage links when optional sitemap fails and reports the failed source", async () => {
    const result = await new NativeWebClient({
      read: async (url) => {
        if (url === sitemap) throw new Error("HTTP 404");
        return response(url, '<a href="/about">About</a>');
      },
    }).map(root);
    expect(result.links).toEqual([{ url: `${root}about` }]);
    expect(result.errors).toEqual([{ url: sitemap, error: "HTTP 404" }]);
    expect(result.partial).toBe(true);
  });

  test.each([false, true])("limits discovered URLs and sitemap reads to same site (subdomains=%s)", async (includeSubdomains) => {
    const read = vi.fn(async (url: string) =>
      response(
        url,
        url === root
          ? "<html/>"
          : urlset([
              `${root}one`,
              "https://sub.example.org/two",
              "https://evil.example.org.attacker.com/three",
              "https://attacker.com/four",
            ]),
      ),
    );
    const result = await new NativeWebClient({ read }).map(root, { includeSubdomains });
    expect(result.links.map((link) => link.url)).toEqual(
      includeSubdomains ? [`${root}one`, "https://sub.example.org/two"] : [`${root}one`],
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  test.each(["<!DOCTYPE urlset>", '<!ENTITY attack "value">'])("rejects unsafe XML declarations %s", async (declaration) => {
    const result = await new NativeWebClient({
      read: async (url) => response(url, url === root ? "<html/>" : declaration + urlset([`${root}bad`])),
    }).map(root);
    expect(result.links).toEqual([]);
    expect(result.errors[0]?.error).toContain("declarations are not allowed");
    expect(result.sources).not.toContainEqual({ url: sitemap, kind: "sitemap" });
  });

  test("rejects malformed sitemap XML without treating it as evidence", async () => {
    const result = await new NativeWebClient({
      read: async (url) => response(url, url === root ? "<html/>" : "<urlset><url><loc>https://example.org/bad</loc></urlset>"),
    }).map(root);
    expect(result.links).toEqual([]);
    expect(result.errors[0]?.error).toBe("Invalid sitemap XML");
    expect(result.sources).not.toContainEqual({ url: sitemap, kind: "sitemap" });
  });

  test("reports truncation and bounds sitemap index traversal", async () => {
    const read = vi.fn(async (url: string) =>
      response(
        url,
        url === root
          ? "<html/>"
          : url === sitemap
            ? `<sitemapindex>${[1, 2, 3, 4, 5].map((n) => `<sitemap><loc>${root}${n}.xml</loc></sitemap>`).join("")}</sitemapindex>`
            : urlset([`${root}b`, `${root}a`]),
      ),
    );
    const result = await new NativeWebClient({ read }).map(root, { limit: 1 });
    expect(read).toHaveBeenCalledTimes(5);
    expect(result.links).toEqual([{ url: `${root}a` }]);
    expect(result.truncated).toBe(true);
    expect(result.partial).toBe(true);
  });

  test("uses one total deadline, preserving sitemap results even if homepage ignores cancellation", async () => {
    vi.useFakeTimers();
    const read = vi.fn((url: string, options?: ReadPublicOptions): Promise<PublicText> => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      if (url === root) return new Promise(() => {});
      return Promise.resolve(response(url, urlset([`${root}found`])));
    });
    const resultPromise = new NativeWebClient({ read }).map(root, { timeout: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;
    expect(result.links).toEqual([{ url: `${root}found` }]);
    expect(result.errors).toEqual([{ url: root, error: "Website map deadline exceeded" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("rejects redirected off-site sitemap evidence", async () => {
    const result = await new NativeWebClient({
      read: async (url) => response(url === root ? root : "https://attacker.com/map", url === root ? "<html/>" : urlset([`${root}bad`])),
    }).map(root);
    expect(result.links).toEqual([]);
    expect(result.errors[0]?.error).toContain("outside the requested site");
  });

  test("does not reset the deadline for child sitemaps", async () => {
    vi.useFakeTimers();
    const budgets: number[] = [];
    const read = async (url: string, options?: ReadPublicOptions) => {
      if (url === root) return response(url, "<html/>");
      budgets.push(options?.timeoutMs ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return response(
        url,
        url === sitemap ? `<sitemapindex><sitemap><loc>${root}child.xml</loc></sitemap></sitemapindex>` : urlset([`${root}late`]),
      );
    };
    const pending = new NativeWebClient({ read }).map(root, { timeout: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(budgets).toEqual([100, 40]);
    expect(result.links).toEqual([]);
    expect(result.errors).toEqual([{ url: `${root}child.xml`, error: "Website map deadline exceeded" }]);
    await vi.advanceTimersByTimeAsync(20);
    expect(result.links).toEqual([]);
  });
});
