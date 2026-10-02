import { describe, expect, test } from "vitest";
import type { RoundRow } from "../lib/persist";
import { slackLogo } from "../lib/slack-blocks";

const row = (company: Partial<RoundRow["company"]>) =>
  ({ company: { id: "acme.com", name: "Acme", domain: "acme.com", logo_url: null, ...company } }) as RoundRow;

describe("slackLogo", () => {
  test("always our own logo route, never a third-party image Slack might fail to fetch", () => {
    const image = slackLogo(row({ logo_url: "https://acme.com/logo.svg" }), "https://fireround.dev");
    expect(image).toEqual({ type: "image", image_url: "https://fireround.dev/api/logo/acme.com", alt_text: "Acme logo" });
  });

  test("the company id is encoded into the path", () => {
    expect(slackLogo(row({ id: "teal health", name: "Teal Health" }), "https://fireround.dev").image_url).toBe(
      "https://fireround.dev/api/logo/teal%20health",
    );
  });
});
