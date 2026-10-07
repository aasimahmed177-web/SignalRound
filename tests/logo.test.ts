import { brandFrom, logoFrom } from "@fireround/core";
import { describe, expect, test } from "vitest";
import { investorInitials } from "../components/investor-logo.tsx";
import { logoSrc, svgAspect, svgLeavesNoMark } from "../lib/logo";

describe("company logos", () => {
  test("logoFrom resolves the scraped favicon against the page and refuses what cannot be shown", () => {
    expect(logoFrom({ favicon: "/favicon.ico" }, "https://acme.com/")).toBe("https://acme.com/favicon.ico");
    expect(logoFrom({ favicon: "https://cdn.acme.com/icon.png" }, "https://acme.com/")).toBe("https://cdn.acme.com/icon.png");
    expect(logoFrom({ favicon: "data:image/png;base64,AAAA" }, "https://acme.com/")).toBeNull();
    expect(logoFrom({ favicon: "javascript:alert(1)" }, "https://acme.com/")).toBeNull();
    expect(logoFrom({ favicon: "  " }, "https://acme.com/")).toBeNull();
    expect(logoFrom(undefined, "https://acme.com/")).toBeNull();
  });

  test("brandFrom keeps the logo file, the written name, and the primary colour; nothing usable is null", () => {
    expect(
      brandFrom({ brandName: " Acme ", logo: "/brand/logo.svg", colors: { primary: "#FF6B35", background: "#fff" } }, "https://acme.com/"),
    ).toEqual({ name: "Acme", logo: "https://acme.com/brand/logo.svg", primary_color: "#FF6B35" });
    // A logo drawn inline in the page comes back as a small data: image, and is served as it is; anything else inline is not a logo.
    expect(brandFrom({ brandName: "Acme", logo: "data:image/svg+xml;base64,AAAA" }, "https://acme.com/")?.logo).toBe(
      "data:image/svg+xml;base64,AAAA",
    );
    expect(brandFrom({ brandName: "Acme", logo: "data:text/html;base64,AAAA" }, "https://acme.com/")).toEqual({
      name: "Acme",
      logo: null,
      primary_color: null,
    });
    expect(brandFrom({ colorScheme: "dark" }, "https://acme.com/")).toBeNull();
    expect(brandFrom(undefined, "https://acme.com/")).toBeNull();
  });

  test("logoSrc: every tile comes from this instance's own route, never a company's host or a favicon service", () => {
    expect(logoSrc("company", "acme.com")).toBe("/api/logo/acme.com?ui=1");
    expect(logoSrc("company", "teal health")).toBe("/api/logo/teal%20health?ui=1");
    expect(logoSrc("investor", "big fund")).toBe("/api/logo/big%20fund?kind=investor&ui=1");
    expect(logoSrc("host", "techcrunch.com")).toBe("/api/logo/techcrunch.com?kind=host&ui=1");
  });

  test("svgAspect reads the viewBox, else the root's width and height", () => {
    expect(svgAspect('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><path d="M0 0"/></svg>')).toBe(4);
    expect(svgAspect('<svg width="64" height="64"><rect/></svg>')).toBe(1);
    expect(svgAspect("<svg><rect/></svg>")).toBeNull();
  });

  test("svgLeavesNoMark: a logo drawn only in white is blank on the light tile; one that names no colour paints black", () => {
    expect(svgLeavesNoMark('<svg><path fill="#fff" d="M0"/><path fill="#FFFFFF" d="M1"/></svg>')).toBe(true);
    expect(svgLeavesNoMark('<svg><path style="fill:white" d="M0"/></svg>')).toBe(true);
    expect(svgLeavesNoMark('<svg><path fill="#fff" d="M0"/><path fill="#111" d="M1"/></svg>')).toBe(false);
    expect(svgLeavesNoMark('<svg><path d="M0"/></svg>')).toBe(false);
    expect(svgLeavesNoMark('<svg><path fill="none" stroke="rgb(255, 255, 255)" d="M0"/></svg>')).toBe(true);
  });

  test("investorInitials: two initials for a firm, a leading article dropped, one letter for a one-word name", () => {
    expect(investorInitials("Insight Partners")).toBe("IP");
    expect(investorInitials("Y Combinator")).toBe("YC");
    expect(investorInitials("The Moon Venture")).toBe("MV");
    expect(investorInitials("Julien Jean (JJCapinvest)")).toBe("JJ");
    expect(investorInitials("Kleiner Perkins Caufield & Byers")).toBe("KP");
    expect(investorInitials("accel")).toBe("A");
    expect(investorInitials("The")).toBe("T");
    expect(investorInitials("  ")).toBe("?");
  });
});
