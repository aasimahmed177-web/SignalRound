import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  activateNativeControl,
  captureStep,
  MAX_STEPS,
  parseArgs,
  redactText,
  SESSION_MS,
  summarizeUrl,
} from "../scripts/guided-funnel.ts";

describe("guided funnel privacy and opt-in", () => {
  it("activates an infinitely animated native button and captures its delayed modal", async () => {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(
        `<style>@keyframes pulse { from { transform: translateX(0px) } to { transform: translateX(150px) } } button { animation: pulse 0.3s linear infinite alternate }</style><button type="button" onclick="setTimeout(() => document.querySelector('dialog').showModal(), 150)">Register free</button><dialog><h1>Free webinar registration</h1><label>Email<input type="email"></label></dialog>`,
      );
      const button = page.getByRole("button", { name: "Register free" });
      await expect(button.click({ timeout: 250 })).rejects.toThrow();
      await activateNativeControl(button);
      await page.getByRole("dialog").waitFor({ state: "visible", timeout: 3_000 });
      expect(JSON.stringify(await captureStep(context))).toContain("Free webinar registration");
    } finally {
      await browser.close();
    }
  });
  it("rejects non-native or disabled activation targets", async () => {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<div role="button" tabindex="0">Custom</div><a>Missing href</a><button disabled>Disabled</button><a href="#next">Native link</a>`,
      );
      await expect(activateNativeControl(page.getByText("Custom", { exact: true }))).rejects.toThrow("native button or link");
      await expect(activateNativeControl(page.getByText("Missing href", { exact: true }))).rejects.toThrow("native button or link");
      await expect(activateNativeControl(page.getByRole("button", { name: "Disabled" }))).rejects.toThrow("disabled");
      await activateNativeControl(page.getByRole("link", { name: "Native link" }));
      expect(page.url()).toBe("about:blank#next");
    } finally {
      await browser.close();
    }
  });
  it("captures a local questionnaire and frame without entered field values", async () => {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(
        `<title>Audit fixture</title><label>Name<input value="Synthetic Tester"></label><p>Welcome Synthetic Tester</p><label>Email<input type="email" value="tester@example.com"></label><label>Budget<select><option>Free</option><option>Paid</option></select></label><button>Continue</button><iframe srcdoc="<h1>Questionnaire</h1>"></iframe>`,
      );
      const step = await captureStep(context);
      const serialized = JSON.stringify(step);
      expect(step.pages[0].frames).toHaveLength(2);
      expect(serialized).toContain("Questionnaire");
      expect(serialized).toContain("Continue");
      expect(serialized).not.toContain("tester@example.com");
      expect(serialized).not.toContain("Synthetic Tester");
      expect(serialized).not.toContain('"enteredValues"');
    } finally {
      await browser.close();
    }
  });
  it("requires explicit live consent and one URL", () => {
    expect(() => parseArgs(["https://example.com"])).toThrow();
    expect(() => parseArgs(["https://example.com", "--allow-live", "--eval=evil"])).toThrow();
    expect(parseArgs(["https://example.com", "--allow-live"])).toEqual({ url: "https://example.com" });
    expect(parseArgs(["--help"])).toBeNull();
    expect(MAX_STEPS).toBe(20);
    expect(SESSION_MS).toBe(900_000);
  });
  it("omits URL credentials, query values and fragments", () => {
    expect(summarizeUrl("https://user:secret@example.com/thank-you?email=person@site.com&token=secret#secret")).toEqual({
      origin: "https://example.com",
      path: "/thank-you",
      queryKeys: ["email", "token"],
    });
    expect(summarizeUrl("data:text/plain,secret").origin).toBe("[non-http]");
    expect(summarizeUrl("not a url").origin).toBe("[invalid URL]");
  });
  it("redacts input echoes and common contact/token patterns", () => {
    const result = redactText("Welcome Synthetic Audit. person@example.com +1 202-555-0147 abcdefghijklmnopqrstuvwxyz0123456789", [
      "Synthetic Audit",
    ]);
    expect(result).not.toContain("Synthetic Audit");
    expect(result).not.toContain("person@example.com");
    expect(result).not.toContain("202-555");
    expect(result).toContain("[token]");
    expect(redactText("x".repeat(15_000)).length).toBeLessThanOrEqual(12_000);
  });
});
