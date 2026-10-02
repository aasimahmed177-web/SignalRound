// Input the web wrote, on its way back out. A stored logo URL is fetched by the open logo route, so it
// may never reach a private address at any hop; a Slack install keeps only a Slack webhook; and a
// source or logo URL placed in a feed, an email, or a Slack message is http(s) or no link at all.

import { afterEach, describe, expect, test, vi } from "vitest";
import { digestHtml } from "../lib/digest";
import { webUrl } from "../lib/links";
import { loadLogo } from "../lib/og";
import { listRounds, persistRecords, setDisposition } from "../lib/persist";
import { isPrivateAddress, publicUrl, type Resolve, safeFetch } from "../lib/safe-fetch";
import { isSlackWebhook } from "../lib/slack";
import { link } from "../lib/slack-blocks";
import { record, testDb } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const resolveTo =
  (table: Record<string, string[]>): Resolve =>
  async (host) => {
    if (!table[host]) throw new Error("ENOTFOUND");
    return table[host];
  };

describe("isPrivateAddress", () => {
  test("loopback, private, link-local, CGNAT, multicast, and v6 local forms are private; public addresses are not", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      "::1",
      "::",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::7f00:1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "104.16.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])
      expect(isPrivateAddress(ip), ip).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("publicUrl", () => {
  const resolve = resolveTo({
    "acme.com": ["104.16.0.1"],
    "rebind.example": ["104.16.0.1", "10.0.0.5"],
    "meta.example": ["169.254.169.254"],
  });

  test("http(s) on the default port to a public address passes", async () => {
    expect((await publicUrl("https://acme.com/logo.png", resolve))?.hostname).toBe("acme.com");
    expect(await publicUrl("http://104.16.0.1/logo.png", resolve)).not.toBeNull();
  });

  test("private literals, every spelling of loopback, local names, odd ports, credentials, and other schemes are refused", async () => {
    for (const raw of [
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost/",
      "http://metadata.google.internal/",
      "http://printer.local/",
      "http://intranet/",
      "https://acme.com:8443/",
      "https://user:pass@acme.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(await publicUrl(raw, resolve), raw).toBeNull();
    }
  });

  test("a name that resolves to any private address, or does not resolve, is refused", async () => {
    expect(await publicUrl("https://meta.example/", resolve)).toBeNull();
    expect(await publicUrl("https://rebind.example/", resolve)).toBeNull();
    expect(await publicUrl("https://nowhere.example/", resolve)).toBeNull();
  });
});

describe("safeFetch", () => {
  const resolve = resolveTo({ "acme.com": ["104.16.0.1"], "cdn.acme.com": ["104.16.0.2"] });

  test("each redirect is checked again: a hop to a private address ends the fetch", async () => {
    const fetchSpy = vi.fn(async (url: URL | string) =>
      String(url).includes("acme.com/start")
        ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } })
        : new Response("secret"),
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect(await safeFetch("https://acme.com/start", {}, resolve)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("a redirect to another public host is followed, with redirect handled by hand", async () => {
    const fetchSpy = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return String(url).startsWith("https://acme.com")
        ? new Response(null, { status: 301, headers: { location: "https://cdn.acme.com/logo.png" } })
        : new Response("png");
    });
    vi.stubGlobal("fetch", fetchSpy);
    expect(await (await safeFetch("https://acme.com/logo.png", {}, resolve))?.text()).toBe("png");
  });

  test("the logo route's loader never fetches a stored logo on a private address", async () => {
    vi.stubEnv("NEXT_PUBLIC_FAVICON_FALLBACK", "off");
    const fetchSpy = vi.fn(async () => new Response("x"));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await loadLogo({ logoUrl: "http://169.254.169.254/latest/meta-data/iam/logo.png" })).toBeNull();
    expect(await loadLogo({ logoUrl: "http://localhost:9001/2018-06-01/runtime/invocation/next" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("isSlackWebhook", () => {
  test("only Slack's webhook hosts over https", () => {
    expect(isSlackWebhook("https://hooks.slack.com/services/T0/B0/x")).toBe(true);
    expect(isSlackWebhook("https://hooks.slack-gov.com/services/T0/B0/x")).toBe(true);
    for (const url of [
      "http://hooks.slack.com/services/x",
      "https://hooks.slack.com.evil.example/x",
      "https://evil.example/hooks.slack.com",
      "https://hooks.slack.com:444/x",
      "nope",
    ]) {
      expect(isSlackWebhook(url), url).toBe(false);
    }
  });
});

describe("links placed outside React", () => {
  test("webUrl passes http(s) and nothing else", () => {
    expect(webUrl("https://news.example/a")).toBe("https://news.example/a");
    expect(webUrl("http://news.example/a")).toBe("http://news.example/a");
    for (const url of ["javascript:alert(1)", "data:text/html,<script>", "www.acme.com", "", null, undefined])
      expect(webUrl(url)).toBeNull();
  });

  test("a Slack link drops a non-web URL and cannot be split by | or >", () => {
    expect(link("javascript:alert(1)", "evil")).toBe("evil");
    expect(link("https://x.example/a|b>c", "x")).toBe("<https://x.example/a%7Cb%3Ec|x>");
  });

  test("the email digest links only web URLs", async () => {
    const db = await testDb();
    const item = record({ company_name: "Acme" });
    await persistRecords(db, [item], "series-a-b", "run-1");
    await setDisposition(db, item.id, "publish");
    const [row] = (await listRounds(db)).rows;
    const hostile = {
      ...row,
      company: { ...row.company, logo_url: "javascript:alert(1)" },
      sources: row.sources.map((s) => ({ ...s, url: "javascript:alert(2)" })),
    };
    const html = digestHtml([hostile], { origin: "https://app.test", cadence: "weekly", presetSlug: null, minConfidence: 0 });
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Acme");
  });
});
