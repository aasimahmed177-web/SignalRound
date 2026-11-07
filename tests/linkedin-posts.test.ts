import { describe, expect, test } from "vitest";
import type { ReadText } from "../lib/job-boards";
import { parseJobInput } from "../lib/jobs";
import {
  activityDate,
  collectLinkedInPosts,
  companyFromDomain,
  dedupePosts,
  emailQuote,
  extractEmails,
  isMarketingRole,
  type LinkedInPost,
  marketingRole,
  parsePostPage,
  postCompany,
  postedVerbatim,
  postLocation,
  readCapped,
  searchQueries,
  toJobInput,
  toPost,
} from "../lib/linkedin-posts";

const URL_A = "https://www.linkedin.com/posts/jane-doe_hiring-seo-activity-7523661958215184384-O99j";
const URL_B = "https://www.linkedin.com/posts/acme_hiring-activity-7522250348833550336-_3j_";

function page(body: string, author = "Jane Doe", type = "Person") {
  const ld = {
    "@context": "http://schema.org",
    "@type": "SocialMediaPosting",
    datePublished: "2026-11-04T08:26:33.717Z",
    articleBody: body,
    author: { "@type": type, name: author },
    comment: [{ "@type": "Comment", text: "Interested, my mail is fan@example.org" }],
  };
  // LinkedIn serializes the body into JSON, so a raw-HTML regex would see "\nhr@..." as "nhr@...".
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>
  <p data-test-id="main-feed-activity-card__commentary">${body.replace(/\n/g, "<br>")}</p></body></html>`;
}

const POST = [
  "🚀 We're Hiring | Junior Social Media Executive",
  "Northwind Webworks is looking for a creative Social Media Executive.",
  "📍 Location: Pune | Work from Office",
  "Share your resume at:",
  "hello@northwindwebworks.example",
  "#Hiring #DigitalMarketingJobs",
].join("\n");

describe("activity id → date", () => {
  test("decodes the timestamp in the top bits of the id", () => {
    expect(activityDate(URL_A)?.toISOString()).toBe("2026-11-04T08:26:33.718Z");
    expect(activityDate("7522250348833550336")?.toISOString().slice(0, 10)).toBe("2026-10-31");
    expect(activityDate("https://www.linkedin.com/feed/update/urn:li:activity:7523661958215184384/")?.getUTCDate()).toBe(4);
    expect(activityDate("https://www.linkedin.com/in/jane")).toBeNull();
  });
});

describe("emails", () => {
  test("come from the decoded text, so an escaped newline never sticks to the address", () => {
    const html = page(POST);
    expect(html).toContain("\\nhello@northwindwebworks.example");
    const parsed = parsePostPage(html);
    expect(extractEmails(parsed!.text)).toEqual(["hello@northwindwebworks.example"]);
  });

  test("ignore comments, image names, and trailing punctuation", () => {
    expect(extractEmails("Mail hr@acmeexample.co.in. Logo logo@2x.png, (jobs@acme.example)")).toEqual([
      "hr@acmeexample.co.in",
      "jobs@acme.example",
    ]);
    expect(extractEmails("no address here, just @handle and a@b")).toEqual([]);
  });

  test("quote the sentence that carries the address", () => {
    expect(
      emailQuote("Great role. To find out more, contact Wren at wren@fieldhouseexample.co.uk. Thanks!", "wren@fieldhouseexample.co.uk"),
    ).toBe("To find out more, contact Wren at wren@fieldhouseexample.co.uk.");
    expect(emailQuote(POST, "hello@northwindwebworks.example")).toBe("hello@northwindwebworks.example");
  });
});

describe("marketing filter", () => {
  test.each([
    [POST, "Junior Social Media Executive"],
    ["WE ARE HIRING\nPosition: SEO Executive\nSend CV to hr@x.example", "SEO Executive"],
    ["We're hiring: VP – Digital Marketing at LEDGERLY ONE", "VP – Digital Marketing"],
    ["We're looking for a talented Media Buyer to join our team!", "Media Buyer"],
    ["WE ARE HIRING\nManager, Brand & Marketing\nJob Responsibilities", "Manager, Brand & Marketing"],
    ["Hiring now:\n• Business Development Executive\n• Senior Executive – Influencer Marketing", "Senior Executive – Influencer Marketing"],
    ["We are hiring a dynamic and result-oriented PPC Executive to join us", "PPC Executive"],
    ["We're hiring: Brand Marketing Lead - Gurgaon", "Brand Marketing Lead"],
    ["Brand Manager & Assistant Brand Manager- Karachi\nShare your CV at careers@x.example", "Brand Manager & Assistant Brand Manager"],
    ["SEO Executive · Northwind · Remote (Pakistan)\nApply: Email CV to careers@northwind.example", "SEO Executive"],
    ["We're hiring\n• Assistant Manager – Paid Media | 2.5 – 3.5 years", "Assistant Manager – Paid Media"],
    ["Hiring!\nRole: Deputy Brand Manager – 2 Positions", "Deputy Brand Manager"],
    ["We're hiring!\n1. Social Media Marketing Intern\n2. Digital Marketing Intern", "Social Media Marketing Intern"],
  ])("finds the role in %#", (text, role) => {
    expect(marketingRole(text)).toBe(role);
  });

  test.each([
    "We're hiring a Backend Engineer. Send CV to jobs@acme.example #digitalmarketing",
    "We're hiring! Role: Styling Intern. Send your resume to a@b.example",
    "Open to work: I am looking for a job as a Digital Marketing Executive. mail me at me@gmail.com",
    "Five tips for better content marketing this quarter.",
    "Hiring for Senior Visual Designer and Junior Graphic Designer at a marketing agency",
    "Calling all digital marketing agencies! We are looking to partner with an experienced 360° Marketing Agency. Mail rfp@clinicexample.in",
  ])("rejects %#", (text) => {
    expect(isMarketingRole(text)).toBe(false);
  });
});

describe("post fields", () => {
  test("company, location", () => {
    expect(postCompany(POST, ["hello@northwindwebworks.example"])).toBe("Northwind Webworks");
    expect(postCompany("We're hiring a Brand Manager. Mail x@tarn-global.example", ["x@tarn-global.example"])).toBe("tarn-global.example");
    expect(postCompany("Hiring an SEO Executive", ["a@gmail.com"], { name: "Acme Ltd", isOrg: true })).toBe("Acme Ltd");
    expect(postCompany("We've got two seats open at 4ward\nWe're hiring! Drop your resume", ["d@4ward.example"])).toBe("4ward");
    expect(postLocation(POST)).toBe("Pune");
    expect(postCompany("Marigold Brands is expanding their Branding Team and looking for people to join us!", [])).toBe("Marigold Brands");
  });

  test("a company the post names instead of the email's bare domain", () => {
    const fernhill =
      "I'm building a marketing team at Fernhill Ventures.\nHiring: Performance Marketing Specialist\nApply Now: info@fernhill.example";
    expect(postCompany(fernhill, ["info@fernhill.example"])).toBe("Fernhill Ventures");
    expect(companyFromDomain("Join Copper Lantern as a Social Strategist", "copperlantern.example")).toBe("Copper Lantern");
    expect(companyFromDomain("We're hiring at FERNHILL", "fernhill.example")).toBe("FERNHILL");
    expect(companyFromDomain("we are hiring", "fernhill.example")).toBeNull();
  });

  test("location from the body when there is no location line", () => {
    expect(postLocation("Hiring an SEO Executive based in Dubai, UAE. Mail a@b.example")).toBe("Dubai, UAE");
    expect(postLocation("Hiring a Content Writer (fully remote). Mail a@b.example")).toBe("Remote");
    expect(postLocation("Hiring a Content Writer. Mail a@b.example")).toBeNull();
  });

  test("a verified record, or why the page was dropped", () => {
    const since = new Date("2026-10-31T00:00:00Z");
    const post = toPost(`${URL_A}?utm=x`, page(POST), since) as LinkedInPost;
    expect(post).toMatchObject({
      post_url: URL_A,
      posted_at: "2026-11-04T08:26:33.718Z",
      author: "Jane Doe",
      company: "Northwind Webworks",
      role: "Junior Social Media Executive",
      emails: ["hello@northwindwebworks.example"],
      is_marketing_role: true,
    });
    expect(post.emails).not.toContain("fan@example.org");
    expect(toPost(URL_A, page(POST), new Date("2026-11-05T00:00:00Z"))).toBe("older than the window");
    expect(toPost(URL_A, page("We're hiring a Marketing Manager! Apply via the link."), since)).toBe("no email in post text");
    expect(toPost(URL_A, "<html></html>", since)).toBe("no post text");
    expect(parseJobInput(toJobInput(post))).toMatchObject({ source: "linkedin-post", external_id: "7523661958215184384", url: URL_A });
  });

  test("dedupe keeps one copy of the same post and of a repost of the same opening", () => {
    const base = toPost(URL_A, page(POST), new Date(0)) as LinkedInPost;
    const repost = { ...base, post_url: URL_B, posted_at: "2026-11-01T00:00:00.000Z" };
    const other = { ...base, post_url: URL_B.replace("7522250348833550336", "7522250348833550337"), role: "SEO Executive" };
    const kept = dedupePosts([base, { ...base, post_url: `${URL_A}#copy` }, repost, other]);
    expect(kept.map((post) => post.post_url)).toEqual([other.post_url, URL_B]);
  });
});

describe("collect", () => {
  test("searches carry the window's months; only recent posts are read", async () => {
    const now = new Date("2026-11-07T12:00:00Z");
    expect(searchQueries(now, 7).some((query) => query.includes("November 2026"))).toBe(true);
    expect(searchQueries(now, 7).some((query) => query.includes("October 2026"))).toBe(true);
    // Day-scoped queries come first, newest day first, and cover every day of the window.
    const queries = searchQueries(now, 7);
    expect(queries[0]).toContain(now.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }));
    for (let d = 0; d < 7; d++) {
      const day = new Date(now.getTime() - d * 86_400_000).toLocaleString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
      expect(queries.some((query) => query.includes(day))).toBe(true);
    }
    const old = "https://www.linkedin.com/posts/x_hiring-activity-7374842890637901824-GAnH";
    const reads: string[] = [];
    const read: ReadText = async (url) => {
      reads.push(url);
      return { text: page(POST), url, status: 200 };
    };
    const { posts, stats } = await collectLinkedInPosts({ days: 7, now, queries: ["q"], search: async () => [URL_A, old, URL_A], read });
    expect(reads).toEqual([URL_A]);
    expect(posts).toHaveLength(1);
    expect(stats).toMatchObject({ found: 3, recent: 1, kept: 1 });
  });
});

describe("email TLDs are never cut into a different address", () => {
  test("real long TLDs stay whole; only known glued words are cut", () => {
    expect(extractEmails("Mail hr@nimbusbrandexample.community or jobs@acmeexample.company")).toEqual([
      "hr@nimbusbrandexample.community",
      "jobs@acmeexample.company",
    ]);
    expect(extractEmails("ops@gridexample.network, x@farmexample.organic, it@shopexample.computer")).toEqual([
      "ops@gridexample.network",
      "x@farmexample.organic",
      "it@shopexample.computer",
    ]);
    expect(extractEmails("Quillhr@gmail.comusing the subject line")).toEqual(["quillhr@gmail.com"]);
    expect(extractEmails("hr@nimbusbrandexample.orgcontact 98765")).toEqual(["hr@nimbusbrandexample.org"]);
  });

  test("a prefix of a longer address is not posted verbatim", () => {
    expect(postedVerbatim("Write to hr@nimbusbrandexample.community today", "hr@nimbusbrandexample.com")).toBe(false);
    expect(postedVerbatim("Write to hr@nimbusbrandexample.com.", "hr@nimbusbrandexample.com")).toBe(true);
    expect(postedVerbatim("Quillhr@gmail.comusing the subject", "quillhr@gmail.com")).toBe(true);
    expect(postedVerbatim("xhr@nimbusbrandexample.com", "hr@nimbusbrandexample.com")).toBe(false);
    expect(postedVerbatim("Mail hr@nimbusbrandexample.com.au now", "hr@nimbusbrandexample.com")).toBe(false);
  });

  test("toPost keeps the .community address as written", () => {
    const body = "We're hiring a Social Media Executive!\nSend your CV to hr@nimbusbrandexample.community";
    const post = toPost(URL_A, page(body), new Date(0)) as LinkedInPost;
    expect(post.emails).toEqual(["hr@nimbusbrandexample.community"]);
  });
});

describe("readCapped", () => {
  test("reads a body and refuses one past the cap", async () => {
    expect(await readCapped(new Response("Ingénieur"))).toBe("Ingénieur");
    await expect(readCapped(new Response("x".repeat(100)), 10)).rejects.toThrow(/larger than 10 bytes/);
  });

  test("decodes a multibyte character split across chunks", async () => {
    const bytes = new TextEncoder().encode("Ingénieur");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    expect(await readCapped(new Response(body))).toBe("Ingénieur");
  });
});
