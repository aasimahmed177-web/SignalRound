// Pricing as the drawer and the company page show it. The cases are plan lists read off real pricing
// pages on the live feed (2026-09-24), so each shape the extractor returns stays covered.

import { describe, expect, test } from "vitest";
import { displayPrice, pricingModelLabel, pricingView } from "../lib/pricing";

const plan = (name: string, price: string | null = null) => ({ name, price_as_written: price });
const price = (raw: string | null) => displayPrice(raw).price;

describe("displayPrice", () => {
  test("billing periods read one way", () => {
    expect(price("$150/month")).toBe("$150/mo");
    expect(price("$0.00/ Month")).toBe("Free");
    expect(price("from $149 / mo")).toBe("from $149/mo");
    expect(price("€17.99/ month")).toBe("€17.99/mo");
    expect(price("€49.99/ 6 months")).toBe("€49.99/6 mo");
    expect(price("€89.99/ year")).toBe("€89.99/yr");
    expect(price("$59 monthly")).toBe("$59/mo");
    expect(price("£75 a month")).toBe("£75/mo");
    expect(price("$30 billed monthly")).toBe("$30/mo");
    expect(price("$2.98/hr")).toBe("$2.98/hr");
  });

  test("per-seat prices put the unit before the period", () => {
    expect(price("$110 per user / month")).toBe("$110/user/mo");
    expect(price("35 per seat/ month")).toBe("35/seat/mo");
    expect(price("$55.00/ Mo / seat")).toBe("$55.00/seat/mo");
    expect(price("$139 per user/month billed annually")).toBe("$139/user/mo, billed annually");
    expect(price("$19 per month, billed annually")).toBe("$19/mo, billed annually");
  });

  test("filler around a figure goes; a range says its unit once", () => {
    expect(price("Pay-as-you-go pricing from $1.12/h to $9.25/h")).toBe("$1.12 to $9.25/hr");
    expect(price("Pay-as-you-go pricing per GPU from $4.46/h to $9.25/h")).toBe("$4.46 to $9.25/hr per GPU");
    expect(price("From $1.63/h to $8.85/h")).toBe("$1.63 to $8.85/hr");
    expect(price("Starting at $79/mo")).toBe("from $79/mo");
    expect(price("Starts at $1.5k/user/year")).toBe("from $1.5k/user/yr");
  });

  test("monthly and a month inside a phrase are words, not a period", () => {
    expect(price("$1,000 in free monthly credits")).toBe("$1,000 in free monthly credits");
  });

  test("two prices side by side keep their separator", () => {
    expect(price("₹6/connected minute / $0.10/connected minute")).toBe("₹6/connected minute / $0.10/connected minute");
  });

  test("zero and its spellings are Free; a zero with a later figure is not", () => {
    for (const raw of ["$0", "$0/month", "$0 / mo", "$0/m", "Free", "free", "forever", "0", "Free per user/month", "Free for beta users"])
      expect(displayPrice(raw)).toEqual({ price: "Free", kind: "free" });
    expect(displayPrice("₹0 for first month, then auto-pay starts ₹500/month").kind).toBe("amount");
    expect(displayPrice("$0 if resolved in favor, $15 if lost").kind).toBe("amount");
  });

  test("a sales-led price is Custom in all its spellings", () => {
    for (const raw of [
      "Custom",
      "Custom Pricing",
      "Custom/yearly",
      "Contact us",
      "Contact Sales",
      "Let's talk",
      "Get a Quote",
      "Get a personalized quote",
      "Volume based pricing",
      "Tailored price per user/month",
    ])
      expect(displayPrice(raw)).toEqual({ price: "Custom", kind: "custom" });
  });

  test("a button copied off the page reads as its label", () => {
    expect(displayPrice("[Start Free Trial](https://dashboard.example.com/?pl=1)")).toEqual({ price: "Free trial", kind: "free" });
    expect(displayPrice("[Contact Us](https://example.com/demo)")).toEqual({ price: "Custom", kind: "custom" });
  });

  test("a sentence where a price should be is text; nothing is none", () => {
    expect(displayPrice("Flexible subscription based on your business size.")).toEqual({
      price: "Flexible subscription based on your business size",
      kind: "text",
    });
    expect(displayPrice(null)).toEqual({ price: null, kind: "none" });
    expect(displayPrice("  ")).toEqual({ price: null, kind: "none" });
  });

  test("terms beside a figure stay", () => {
    expect(price("$75 per filing, $150 per registration")).toBe("$75 per filing, $150 per registration");
    expect(price("3.9% + 40¢ per successful transaction")).toBe("3.9% + 40¢ per successful transaction");
    expect(price("79€ /mois")).toBe("79€/mois");
  });
});

describe("pricingView", () => {
  test("no plans, no rows", () => {
    expect(pricingView([]).rows).toEqual([]);
  });

  test("a lineup with no price reads on request, whether blank, sentences, or Custom", () => {
    expect(pricingView([plan("Pro"), plan("Team")]).onRequest).toBe(true);
    expect(pricingView([plan("ERP Sync", "Flexible subscription based on your business size")]).onRequest).toBe(true);
    expect(pricingView([plan("CLX", "Get a personalized quote"), plan("MLX", "Contact us")]).onRequest).toBe(true);
    expect(pricingView([plan("Capsule", "Free"), plan("kMetal", "Custom")]).onRequest).toBe(false);
    expect(pricingView([plan("Team", "€20 per seat"), plan("Pro", "Contact us")]).onRequest).toBe(false);
  });

  test("plans keep page order, name and tidy price, and the original in the title", () => {
    const v = pricingView([plan("Free", "$0/month"), plan("Hobby", "$16/month"), plan("Enterprise", "Custom")]);
    expect(v.rows.map((r) => [r.name, r.price])).toEqual([
      ["Free", "Free"],
      ["Hobby", "$16/mo"],
      ["Enterprise", "Custom"],
    ]);
    expect(v.rows[1].title).toBe("Hobby: $16/month");
    expect(v.showsFree).toBe(true);
  });

  test("adjacent plans sharing a family group under it; a lone one keeps its whole name", () => {
    const v = pricingView([
      plan("GPU Instances - On-demand", "Pay-as-you-go pricing from $1.12/h to $9.25/h"),
      plan("GPU Instances - Reserved", "Discounts up to 25% off on-demand"),
      plan("CPU Instances - On-demand", "Pay-as-you-go pricing from $0.0480/h to $4.41/h"),
      plan("Voice Agents (Pay as you go)", "$0.10/connected minute"),
      plan("Voice Agents (Enterprise)", "Contact Sales"),
    ]);
    expect(v.rows.map((r) => [r.group, r.name, r.price])).toEqual([
      ["GPU Instances", "On-demand", "$1.12 to $9.25/hr"],
      ["GPU Instances", "Reserved", "Discounts up to 25% off on-demand"],
      [null, "CPU Instances - On-demand", "$0.0480 to $4.41/hr"],
      ["Voice Agents", "Pay as you go", "$0.10/connected minute"],
      ["Voice Agents", "Enterprise", "Custom"],
    ]);
  });

  test("an exact repeat drops; a name listed again at another price folds into one row", () => {
    const v = pricingView([
      plan("GLM-5.3-Flash", "$0.15"),
      plan("Digs Pro", "$59 monthly"),
      plan("GLM-5.3-Flash", "$0.15"),
      plan("Digs Pro", "$69 monthly"),
    ]);
    expect(v.rows.map((r) => [r.name, r.price])).toEqual([
      ["GLM-5.3-Flash", "$0.15"],
      ["Digs Pro", "$59/mo or $69/mo"],
    ]);
    expect(v.rows[1].title).toBe("Digs Pro: $59 monthly\nDigs Pro: $69 monthly");
  });

  test("a free tier the rows do not show is left for the tag", () => {
    expect(pricingView([plan("Core", "$139 per user/month")]).showsFree).toBe(false);
  });
});

describe("pricingModelLabel", () => {
  test("each model reads as a label; unknown says nothing", () => {
    expect(pricingModelLabel("usage-based")).toBe("Usage-based");
    expect(pricingModelLabel("hybrid (plans plus usage)")).toBe("Plans plus usage");
    expect(pricingModelLabel("sales-led (contact us)")).toBe("Sales-led");
    expect(pricingModelLabel("unknown")).toBeNull();
    expect(pricingModelLabel(null)).toBeNull();
    expect(pricingModelLabel("per outcome")).toBe("Per outcome");
  });
});
