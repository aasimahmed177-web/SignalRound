import { describe, expect, test } from "vitest";
import {
  collectSocialHiring,
  parseAgentReach,
  parseRedditAtom,
  parseRedditJson,
  SOCIAL_USER_AGENT,
  type SocialFetch,
  type SocialPost,
  toSocialJob,
} from "../lib/social-hiring";

const NOW = new Date("2026-11-07T12:00:00Z");
const SINCE = new Date(NOW.getTime() - 7 * 86_400_000);
const at = (daysAgo: number) => (NOW.getTime() - daysAgo * 86_400_000) / 1000;

const LISTING = {
  kind: "Listing",
  data: {
    children: [
      {
        kind: "t3",
        data: {
          title: "[Hiring] Social Media Manager (Remote, part-time)",
          selftext:
            "Acme Bakes is hiring a Social Media Manager to run our Instagram and TikTok.\n\nLocation: Remote\n\nTo apply, email your portfolio to jobs@acmebakes.example with the subject SMM.",
          permalink: "/r/forhire/comments/abc123/hiring_social_media_manager/",
          created_utc: at(2),
          author: "acmebakes",
        },
      },
      {
        kind: "t3",
        data: {
          title: "[For Hire] SEO specialist with 5 years experience",
          selftext: "I offer SEO audits. Email me at seo.pro@gmail.com",
          permalink: "/r/forhire/comments/def456/for_hire_seo/",
          created_utc: at(1),
          author: "seopro",
        },
      },
      {
        kind: "t3",
        data: {
          title: "[Hiring] Content Writer",
          selftext: "We are hiring a Content Writer. Questions go to jobs-relay@reddit.com; apply through the form.",
          permalink: "/r/forhire/comments/ghi789/hiring_content_writer/",
          created_utc: at(3),
          author: "someco",
        },
      },
      {
        kind: "t3",
        data: {
          title: "[Hiring] Marketing Manager",
          selftext: "We are hiring a Marketing Manager. Send your CV to hr@oldco.example",
          permalink: "/r/forhire/comments/jkl012/hiring_marketing_manager/",
          created_utc: at(10),
          author: "oldco",
        },
      },
      {
        kind: "t3",
        data: {
          title: "[Hiring] Backend Engineer",
          selftext: "We are hiring a backend engineer. Send your CV to dev@techco.example",
          permalink: "/r/forhire/comments/mno345/hiring_backend/",
          created_utc: at(1),
          author: "techco",
        },
      },
    ],
  },
};

const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><author><name>/u/brandco</name></author><content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;BrandCo is hiring a Performance Marketing Manager.&lt;/p&gt;&lt;p&gt;Send your CV to careers@brandco.example&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; submitted by &lt;a href=&quot;https://www.reddit.com/user/brandco&quot;&gt; /u/brandco &lt;/a&gt;</content><id>t3_x1</id><link href="https://www.reddit.com/r/marketingjobs/comments/x1/hiring/" /><updated>2026-11-06T10:00:00+00:00</updated><published>2026-11-06T10:00:00+00:00</published><title>[Hiring] Performance Marketing Manager</title></entry></feed>`;

const posts = parseRedditJson(LISTING);
const job = (post: SocialPost) => toSocialJob(post, SINCE, NOW);

describe("reddit posts", () => {
  test("parses the search JSON", () => {
    expect(posts).toHaveLength(5);
    expect(posts[0]).toMatchObject({
      source: "reddit",
      url: "https://www.reddit.com/r/forhire/comments/abc123/hiring_social_media_manager/",
      author: "acmebakes",
      posted_at: new Date(at(2) * 1000).toISOString(),
    });
  });

  test("keeps a marketing hiring post with its verbatim email line", () => {
    expect(job(posts[0] as SocialPost)).toMatchObject({
      title: "Social Media Manager",
      source: "reddit",
      source_url: posts[0]?.url,
      emails: ["jobs@acmebakes.example"],
      email_source_quote: "To apply, email your portfolio to jobs@acmebakes.example with the subject SMM.",
      remote: true,
    });
  });

  test("drops for-hire posts, platform addresses, old posts and non-marketing roles", () => {
    expect(posts.slice(1).map(job)).toEqual([
      "offering services",
      "no application email",
      "older than the window",
      "not a marketing hiring post",
    ]);
  });

  test("parses the public Atom feed", () => {
    const [post] = parseRedditAtom(ATOM);
    expect(post).toMatchObject({ author: "brandco", url: "https://www.reddit.com/r/marketingjobs/comments/x1/hiring/" });
    expect(post?.text).toBe("BrandCo is hiring a Performance Marketing Manager.\nSend your CV to careers@brandco.example");
    expect(job(post as SocialPost)).toMatchObject({
      emails: ["careers@brandco.example"],
      email_source_quote: "Send your CV to careers@brandco.example",
    });
  });
});

describe("x posts", () => {
  test("keeps only dated x.com status links", () => {
    const output = JSON.stringify({
      ok: true,
      items: [
        {
          url: "https://x.com/growthco/status/1850000000000000000",
          text: "We're hiring a Growth Marketing Manager! Send your resume to talent@growthco.example",
          published_at: "2026-11-05T09:00:00Z",
        },
        { url: "https://example.com/post", text: "hiring", published_at: "2026-11-05T09:00:00Z" },
        { url: "https://x.com/a/status/1", text: "no date" },
      ],
    });
    const found = parseAgentReach(output);
    expect(found).toHaveLength(1);
    expect(job(found[0] as SocialPost)).toMatchObject({ source: "x", emails: ["talent@growthco.example"], company: "growthco.example" });
  });
});

describe("collectSocialHiring", () => {
  test("falls back to the Atom feed when JSON needs a login, and X being unavailable does not throw", async () => {
    const requests: string[] = [];
    const fetch: SocialFetch = async (url) => {
      requests.push(url);
      if (url.includes("search.json")) return { status: 302, text: "" };
      if (url.includes("search.rss")) return { status: 200, text: ATOM };
      return { status: 404, text: "" };
    };
    const { jobs, stats } = await collectSocialHiring({
      days: 7,
      now: NOW,
      subreddits: [
        ["forhire", "hiring marketing"],
        ["marketingjobs", "hiring"],
      ],
      fetch,
      delayMs: 0,
      agentReach: async () => JSON.stringify({ ok: false, error: { code: "RATE_LIMITED" } }),
    });
    expect(requests.filter((url) => url.includes("search.json"))).toHaveLength(1);
    expect(jobs.map((j) => j.emails)).toEqual([["careers@brandco.example"]]);
    expect(stats).toMatchObject({ reddit_json_blocked: 1, x_unavailable: 1, social_with_email: 1 });
  });

  test("reads the JSON when it is served, and a crashing agent-reach is recorded", async () => {
    const { jobs, stats } = await collectSocialHiring({
      days: 7,
      now: NOW,
      subreddits: [["forhire", "hiring marketing"]],
      fetch: async () => ({ status: 200, text: JSON.stringify(LISTING) }),
      delayMs: 0,
      agentReach: async () => {
        throw new Error("spawn agent-reach ENOENT");
      },
    });
    expect(jobs.map((j) => j.source_url)).toEqual(["https://www.reddit.com/r/forhire/comments/abc123/hiring_social_media_manager/"]);
    expect(stats.x_unavailable).toBe(1);
  });

  test("the User-Agent names the project without a personal email", () => {
    expect(SOCIAL_USER_AGENT).toMatch(/SignalRound/);
    expect(SOCIAL_USER_AGENT).not.toMatch(/@/);
  });
});

describe("review regressions", () => {
  test("an Atom entry with an unparsable date is skipped, not thrown", () => {
    const bad = ATOM.replace(
      /<entry>/,
      `<entry><link href="https://www.reddit.com/r/x/comments/bad/" /><published>not a date</published></entry><entry>`,
    );
    const parsed = parseRedditAtom(bad);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.author).toBe("brandco");
  });

  test("a real long TLD is kept as written, never cut to .com", () => {
    const post: SocialPost = {
      source: "reddit",
      url: "https://www.reddit.com/r/forhire/comments/tld1/hiring/",
      title: "[Hiring] Social Media Manager",
      text: "Nimbus Brand is hiring a Social Media Manager. Send your CV to hr@nimbusbrandexample.community",
      author: "nimbusbrand",
      posted_at: NOW.toISOString(),
    };
    const result = job(post);
    expect(typeof result !== "string" && result.emails).toEqual(["hr@nimbusbrandexample.community"]);
  });
});
