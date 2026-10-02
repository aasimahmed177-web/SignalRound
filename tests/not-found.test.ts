import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { entityPath } from "../lib/entity-exists";
import { missingPage } from "../lib/not-found";
import { proxy } from "../proxy";

describe("missingPage", () => {
  test("a missing company names itself and starts a company search with the words from the link", () => {
    const page = missingPage("/companies/antropic");
    expect(page.title).toBe("No company at this address.");
    expect(page.body).toMatch(/^Check the spelling/);
    expect(page).toMatchObject({ searchAction: "/companies", prefill: "antropic" });
    // The proxy rewrites a miss under /_missing; the kind still reads.
    expect(missingPage("/_missing/companies/prevision%20medicine").prefill).toBe("prevision medicine");
  });
  test("a missing investor searches investors; any other address searches the rounds, with no prefill", () => {
    expect(missingPage("/investors/sequioa")).toMatchObject({ searchAction: "/investors", prefill: "sequioa" });
    expect(missingPage("/does-not-exist")).toMatchObject({ title: "Nothing at this address.", searchAction: "/feed", prefill: "" });
    expect(missingPage(null).searchAction).toBe("/feed");
  });
  test("no copy blames a merge first or says 'the store'", () => {
    for (const p of ["/companies/x", "/investors/x", "/x"]) expect(missingPage(p).body).not.toMatch(/the store|may have been merged/);
  });
});

describe("entityPath", () => {
  test("reads a company or investor page and nothing below it", () => {
    expect(entityPath("/companies/acme.com")).toEqual({ kind: "companies", id: "acme.com" });
    expect(entityPath("/investors/big%20fund")).toEqual({ kind: "investors", id: "big fund" });
    expect(entityPath("/investors/big-fund")).toEqual({ kind: "investors", id: "big fund" });
    expect(entityPath("/companies/acme.com/opengraph-image")).toBeNull();
    expect(entityPath("/companies")).toBeNull();
    expect(entityPath("/feed")).toBeNull();
  });
});

describe("proxy entity check", () => {
  test("without a database URL an entity page goes straight through the gate, synchronously", () => {
    const before = { url: process.env.DATABASE_URL, demo: process.env.PUBLIC_DEMO };
    delete process.env.DATABASE_URL;
    process.env.PUBLIC_DEMO = "1";
    try {
      const res = proxy(new NextRequest("http://app.test/companies/nonexistent.com"));
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).headers.get("x-middleware-next")).toBe("1");
    } finally {
      if (before.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before.url;
      if (before.demo === undefined) delete process.env.PUBLIC_DEMO;
      else process.env.PUBLIC_DEMO = before.demo;
    }
  });
});
