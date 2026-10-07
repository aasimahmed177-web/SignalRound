import { createHmac } from "node:crypto";
import { schema } from "@fireround/core/db";
import { eq } from "drizzle-orm";
import type { Firecrawl } from "firecrawl";
import { afterEach, describe, expect, test } from "vitest";
import { corroborateRecord } from "../lib/corroborate";
import {
  enqueueDeliveries,
  flushDeliveries,
  readDigestState,
  sendSampleDigest,
  signStandardWebhook,
  slackBlocks,
  writeDigestState,
} from "../lib/delivery";
import { digestUnsubscribeUrl } from "../lib/digest";
import { signForTests, verifyFirecrawlSignature } from "../lib/firecrawl-webhook";
import { listRounds, persistRecords as persistUnchecked } from "../lib/persist";
import { createEmailTarget, createTarget } from "../lib/settings";
import { record as recordOn, testDb } from "./helpers";

// Rounds announced today: the news rule sends nothing announced more than 14 days before sending (lib/deliverable.ts).
const TODAY = new Date().toISOString().slice(0, 10);
const record = (partial: Parameters<typeof recordOn>[0]) => recordOn({ announced_date: TODAY, ...partial });

async function persistRecords(...args: Parameters<typeof persistUnchecked>) {
  const result = await persistUnchecked(...args);
  const searched = { search: async () => ({ news: [], web: [] }), map: async () => ({ links: [] }) } as unknown as Firecrawl;
  for (const id of result.insertedIds) await corroborateRecord(args[0], searched, id, { broad: true, maxPages: 0 });
  return result;
}

describe("signatures", () => {
  test("Standard Webhooks signature is v1,<base64 HMAC of id.timestamp.body>", () => {
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const sig = signStandardWebhook(secret, "msg_1", 1700000000, '{"a":1}');
    const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update('msg_1.1700000000.{"a":1}')
      .digest("base64");
    expect(sig).toBe(`v1,${expected}`);
  });

  test("Firecrawl signature verification is exact and constant-length", () => {
    const body = '{"type":"monitor.page"}';
    const good = signForTests(body, "s3cret");
    expect(verifyFirecrawlSignature(body, good, "s3cret")).toBe(true);
    expect(verifyFirecrawlSignature(body, good, "other")).toBe(false);
    expect(verifyFirecrawlSignature(`${body} `, good, "s3cret")).toBe(false);
    expect(verifyFirecrawlSignature(body, null, "s3cret")).toBe(false);
    expect(verifyFirecrawlSignature(body, "sha256=abc", "s3cret")).toBe(false);
  });
});

describe("outbox", () => {
  test("queues once per target above the confidence floor, sends, backs off on failure, dead-letters", async () => {
    const db = await testDb();
    const good = record({ company_name: "Acme", confidence: 0.9 });
    const weak = record({ company_name: "Weak", confidence: 0.55, company_key: "weak" });
    await persistRecords(db, [good, weak], "series-a-b", "run-1");
    const slack = await createTarget(db, { channel: "slack", target: "https://hooks.slack.test/abc", minConfidence: 0.75 });
    const hook = await createTarget(db, { channel: "webhook", target: "https://hooks.example.test/funding", minConfidence: 0.5 });
    expect(hook.secret).toMatch(/^whsec_/);

    const queued = await enqueueDeliveries(db, [good.id, weak.id], "series-a-b");
    expect(queued).toBe(3); // Acme -> slack + webhook; Weak -> webhook only

    const calls: Array<{ url: string; headers: Record<string, string>; body: string; signal: unknown }> = [];
    const fetchOk: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: String(init?.body),
        signal: init?.signal,
      });
      return new Response("ok", { status: 200 });
    };
    const first = await flushDeliveries(db, "https://app.test", fetchOk);
    expect(first).toEqual({ sent: 3, failed: 0, deadLettered: 0 });
    const webhookCall = calls.find((c) => c.url.includes("hooks.example.test") && c.body.includes("Acme"));
    expect(webhookCall).toBeDefined();
    expect(webhookCall?.headers["webhook-id"]).toMatch(/^msg_/);
    expect(webhookCall?.headers["webhook-signature"]).toMatch(/^v1,/);
    const payload = JSON.parse(webhookCall?.body ?? "{}");
    expect(payload.type).toBe("round.created");
    expect(payload.data.company.name).toBe("Acme");
    const slackCall = calls.find((c) => c.url.includes("hooks.slack.test"));
    expect(JSON.parse(slackCall?.body ?? "{}").blocks[1].type).toBe("header");
    // Every send carries an abort signal so a hung endpoint cannot stall the outbox.
    expect(slackCall?.signal).toBeInstanceOf(AbortSignal);
    expect(webhookCall?.signal).toBeInstanceOf(AbortSignal);

    // Nothing left to send.
    expect(await flushDeliveries(db, "https://app.test", fetchOk)).toEqual({ sent: 0, failed: 0, deadLettered: 0 });

    // Failures back off and eventually dead-letter.
    void slack;
    const late = record({ company_name: "Late", company_key: "late", confidence: 0.9 });
    await persistRecords(db, [late], "series-a-b", "run-2");
    await enqueueDeliveries(db, [late.id], "series-a-b");
    const fetchFail: typeof fetch = async () => new Response("nope", { status: 500 });
    const failed = await flushDeliveries(db, "https://app.test", fetchFail);
    expect(failed.failed).toBe(2);
    // Not due yet (backoff), so a second flush sends nothing.
    expect(await flushDeliveries(db, "https://app.test", fetchFail)).toEqual({ sent: 0, failed: 0, deadLettered: 0 });
  });

  test("a Slack message is a headline, the company, a field grid, the verdict, and two buttons", async () => {
    const db = await testDb();
    const r = recordOn({
      company_name: "Acme",
      company_domain: "acme.dev",
      company_website: "https://www.acme.dev/",
      company_description: "payments for <robots> & agents",
      other_investors: ["Fund Two", "Fund Three", "Fund Four", "Fund Five"],
      sources: [
        { url: "https://news.example/acme", host: "news.example", title: "Acme raises $20M" },
        { url: "https://www.wire.example/acme", host: "www.wire.example", title: "Acme" },
        { url: "https://three.example/a", host: "three.example" },
        { url: "https://acme.dev/press/a", host: "acme.dev" },
      ],
      verification: { status: "confirmed", notes: [], url: "https://news.example/acme", sources_seen: 4 },
    });
    await persistRecords(db, [r], "series-a-b", "run-1");
    const { rows } = await listRounds(db);
    const msg = slackBlocks(rows[0], "https://app.test");

    expect(msg.text).toBe("Acme raised a $20M Series A, led by Fund One");
    expect(msg.unfurl_links).toBe(false);
    expect(msg.blocks.map((b) => b.type)).toEqual(["context", "header", "section", "section", "context", "actions"]);

    const [brand, header, about, grid, context, actions] = msg.blocks;
    // The brand line: the logo from our own route, inline, then the company and its site.
    expect(brand).toEqual({
      type: "context",
      elements: [
        { type: "image", image_url: "https://app.test/api/logo/acme.dev", alt_text: "Acme logo" },
        { type: "mrkdwn", text: "*Acme* · <https://www.acme.dev/|acme.dev>" },
      ],
    });
    expect(header).toEqual({ type: "header", text: { type: "plain_text", text: "Acme raised a $20M Series A" } });
    // Record text is escaped for mrkdwn, so a stray bracket cannot open a link.
    expect(about.type === "section" && about.text?.text).toBe("Payments for &lt;robots&gt; &amp; agents");
    const fields = grid.type === "section" ? (grid.fields ?? []).map((f) => f.text) : [];
    expect(fields).toEqual([
      "*Amount*\n$20M",
      "*Stage*\nSeries A",
      "*Lead*\nFund One",
      "*Announced*\nSep 2, 2026",
      "*Sector*\nFintech",
      "*Also in*\nFund Two, Fund Three, Fund Four and 1 more",
    ]);
    // The company's own page leads the sources (lib/source-order.ts), then the rest by URL.
    expect(context.type === "context" && context.elements[0].type === "mrkdwn" && context.elements[0].text).toBe(
      "*Verified* against 4 sources · <https://acme.dev/press/a|acme.dev>, <https://news.example/acme|news.example>, <https://three.example/a|three.example> and 1 more",
    );
    const buttons = actions.type === "actions" ? actions.elements : [];
    expect(buttons.map((b) => [b.text.text, b.url])).toEqual([
      ["Open round", "https://app.test/companies/acme.dev"],
      ["Read the source", "https://news.example/acme"],
    ]);
    // Inside Slack's limits: a header of 150 characters, at most ten fields.
    expect(header.type === "header" && header.text.text.length).toBeLessThanOrEqual(150);
    expect(fields.length).toBeLessThanOrEqual(10);

    // A field the record lacks is left out, never printed as a placeholder; no description, no company line.
    await persistRecords(db, [record({ company_name: "Nosector", sector: null })], "series-a-b", "run-1");
    const [bare] = (await listRounds(db, { company: "Nosector" })).rows;
    const bareMsg = slackBlocks(bare, "https://app.test");
    expect(bareMsg.blocks.map((b) => b.type)).toEqual(["context", "header", "section", "context", "actions"]);
    const bareFields = bareMsg.blocks[2].type === "section" ? (bareMsg.blocks[2].fields ?? []).map((f) => f.text).join("\n") : "";
    expect(bareFields).not.toContain("Sector");
    expect(bareFields).not.toContain("Also in");
  });
});

describe("email digest", () => {
  const env = { key: process.env.RESEND_API_KEY, from: process.env.DIGEST_FROM };
  afterEach(() => {
    process.env.RESEND_API_KEY = env.key;
    process.env.DIGEST_FROM = env.from;
    if (env.key === undefined) delete process.env.RESEND_API_KEY;
    if (env.from === undefined) delete process.env.DIGEST_FROM;
  });

  function capture() {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetchOk: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: JSON.parse(String(init?.body)),
      });
      return new Response('{"id":"email_1"}', { status: 200 });
    };
    return { calls, fetchOk };
  }

  async function statuses(db: Awaited<ReturnType<typeof testDb>>, targetId: string) {
    return db
      .select({ status: schema.deliveries.status, lastError: schema.deliveries.lastError })
      .from(schema.deliveries)
      .where(eq(schema.deliveries.target, targetId));
  }

  test("two pending rows become one Resend call, both sent, lastSentAt written; the window then holds", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.DIGEST_FROM = "Fireround <digest@app.test>";
    const db = await testDb();
    await persistRecords(
      db,
      [record({ company_name: "Acme" }), record({ company_name: "Beta", company_key: "beta" })],
      "series-a-b",
      "run-1",
    );
    const email = await createEmailTarget(db, { target: "deals@example.test", cadence: "weekly", minConfidence: 0.5 });
    expect(await readDigestState(db, email.id)).toEqual({ cadence: "weekly", lastSentAt: null });
    const { rows } = await listRounds(db);
    expect(
      await enqueueDeliveries(
        db,
        rows.map((r) => r.id),
        "series-a-b",
      ),
    ).toBe(2);

    const { calls, fetchOk } = capture();
    expect(await flushDeliveries(db, "https://app.test", fetchOk)).toEqual({ sent: 2, failed: 0, deadLettered: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].headers.authorization).toBe("Bearer re_test");
    expect(calls[0].body.from).toBe("Fireround <digest@app.test>");
    expect(calls[0].body.to).toBe("deals@example.test");
    expect(calls[0].body.subject).toBe("Fireround: 2 rounds newly found this week");
    expect(String(calls[0].body.html)).toContain("Acme");
    expect(String(calls[0].body.html)).toContain("Beta");
    expect(String(calls[0].body.text)).toContain("https://app.test/feed");
    // Every digest carries its signed unsubscribe link, in the body and as RFC 8058 one-click headers.
    const unsubscribe = digestUnsubscribeUrl("https://app.test", email.id, "re_test");
    expect(calls[0].body.headers).toEqual({
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(String(calls[0].body.text)).toContain(`Unsubscribe: ${unsubscribe}`);
    expect((await statuses(db, email.id)).map((s) => s.status)).toEqual(["sent", "sent"]);
    const state = await readDigestState(db, email.id);
    expect(state.cadence).toBe("weekly");
    expect(state.lastSentAt).not.toBeNull();

    // Inside the window: a new row waits, nothing is sent.
    await persistRecords(db, [record({ company_name: "Gamma", company_key: "gamma" })], "series-a-b", "run-2");
    const gamma = (await listRounds(db, { company: "Gamma" })).rows[0];
    expect(await enqueueDeliveries(db, [gamma.id], "series-a-b")).toBe(1);
    expect(await flushDeliveries(db, "https://app.test", fetchOk)).toEqual({ sent: 0, failed: 0, deadLettered: 0 });
    expect(calls).toHaveLength(1);
    expect((await statuses(db, email.id)).filter((s) => s.status === "pending")).toHaveLength(1);

    // Once the window has passed, the waiting row goes out as the next digest.
    await writeDigestState(db, email.id, { cadence: "weekly", lastSentAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    expect(await flushDeliveries(db, "https://app.test", fetchOk)).toEqual({ sent: 1, failed: 0, deadLettered: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.subject).toBe("Fireround: 1 round newly found this week");
  });

  test("a missing key leaves rows pending with the reason on the row", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.DIGEST_FROM = "Fireround <digest@app.test>";
    const db = await testDb();
    await persistRecords(db, [record({ company_name: "Acme" })], "series-a-b", "run-1");
    const email = await createEmailTarget(db, { target: "deals@example.test", cadence: "daily" });
    const { rows } = await listRounds(db);
    await enqueueDeliveries(db, [rows[0].id], "series-a-b");
    const { calls, fetchOk } = capture();
    expect(await flushDeliveries(db, "https://app.test", fetchOk)).toEqual({ sent: 0, failed: 0, deadLettered: 0 });
    expect(calls).toHaveLength(0);
    const [row] = await statuses(db, email.id);
    expect(row.status).toBe("pending");
    expect(row.lastError).toContain("RESEND_API_KEY");
    expect((await readDigestState(db, email.id)).lastSentAt).toBeNull();

    // The sample send reports the same reason instead of throwing.
    const sample = await sendSampleDigest(db, email.id, "https://app.test", fetchOk);
    expect(sample.round).toBe(rows[0].id);
    expect(sample.error).toContain("RESEND_API_KEY");
  });

  test("a sample digest sends one round and leaves the outbox and cadence alone", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.DIGEST_FROM = "Fireround <digest@app.test>";
    const db = await testDb();
    await persistRecords(db, [record({ company_name: "Acme" })], "series-a-b", "run-1");
    const email = await createEmailTarget(db, { target: "deals@example.test", cadence: "daily" });
    const { calls, fetchOk } = capture();
    const sample = await sendSampleDigest(db, email.id, "https://app.test", fetchOk);
    expect(sample.error).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.subject).toBe("Fireround: 1 round newly found today");
    expect(await statuses(db, email.id)).toHaveLength(0);
    expect((await readDigestState(db, email.id)).lastSentAt).toBeNull();
  });
});
