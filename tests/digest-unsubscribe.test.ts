// An email digest's unsubscribe: the signed link in every digest and its List-Unsubscribe header,
// a GET that only asks, and a POST (the page's button or a mail client's one-click) that turns the
// target off. A forged or unsigned link changes nothing.
import { type Db, schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, test } from "vitest";
import { GET, POST } from "../app/api/digest/unsubscribe/route";
import { digestHtml, digestText, digestUnsubscribeToken, digestUnsubscribeUrl } from "../lib/digest";
import { createEmailTarget } from "../lib/settings";
import { testDb } from "./helpers";

afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

async function enabled(handle: Db, id: string): Promise<boolean | undefined> {
  const { deliveryTargets } = schema;
  const [row] = await handle.select({ enabled: deliveryTargets.enabled }).from(deliveryTargets).where(eq(deliveryTargets.id, id));
  return row?.enabled;
}

describe("the digest's unsubscribe link", () => {
  test("is signed per target, and the digest carries it in the HTML and the text", () => {
    const url = digestUnsubscribeUrl("https://app.test", "t1", "re_key");
    expect(url).toBe(`https://app.test/api/digest/unsubscribe?t=t1&s=${digestUnsubscribeToken("t1", "re_key")}`);
    expect(digestUnsubscribeToken("t1", "re_key")).not.toBe(digestUnsubscribeToken("t2", "re_key"));
    expect(digestUnsubscribeToken("t1", "re_key")).not.toBe(digestUnsubscribeToken("t1", "re_other"));
    const scope = { origin: "https://app.test", cadence: "daily" as const, presetSlug: null, minConfidence: 0.5, unsubscribeUrl: url };
    expect(digestHtml([], scope)).toContain(`href="${url.replace(/&/g, "&amp;")}"`);
    expect(digestHtml([], scope)).toContain("0 rounds newly found today");
    expect(digestText([], scope)).toContain(`Unsubscribe: ${url}`);
  });

  test("GET only asks; POST turns the email target off; a forged link does nothing", async () => {
    process.env.RESEND_API_KEY = "re_key";
    const handle = await testDb();
    const target = await createEmailTarget(handle, { target: "deals@example.test", cadence: "weekly", minConfidence: 0.5 });
    const url = digestUnsubscribeUrl("https://app.test", target.id, "re_key");

    const asked = await GET(new NextRequest(url));
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain('<form method="post"');
    expect(await enabled(handle, target.id)).toBe(true);

    const forged = `https://app.test/api/digest/unsubscribe?t=${target.id}&s=${digestUnsubscribeToken(target.id, "re_wrong")}`;
    expect((await POST(new NextRequest(forged, { method: "POST" }))).status).toBe(400);
    expect((await GET(new NextRequest(`https://app.test/api/digest/unsubscribe?t=${target.id}`))).status).toBe(400);
    expect(await enabled(handle, target.id)).toBe(true);

    const done = await POST(
      new NextRequest(url, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(done.status).toBe(200);
    expect(await enabled(handle, target.id)).toBe(false);
  });

  test("without a Resend key every link is refused", async () => {
    const url = digestUnsubscribeUrl("https://app.test", "t1", "re_key");
    expect((await POST(new NextRequest(url, { method: "POST" }))).status).toBe(400);
  });
});
