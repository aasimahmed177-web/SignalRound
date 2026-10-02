import { describe, expect, test } from "vitest";
import { cn, HOUSE_TYPE_STYLES } from "../lib/utils";

describe("cn and the house type utilities", () => {
  test("a type class survives a color that follows it", () => {
    expect(cn("text-mono-x-small", "text-black-alpha-32 dark:text-muted-foreground")).toBe(
      "text-mono-x-small text-black-alpha-32 dark:text-muted-foreground",
    );
    expect(cn("whitespace-nowrap text-mono-small", "text-heat-100")).toBe("whitespace-nowrap text-mono-small text-heat-100");
  });

  test("two type classes conflict, and a type class overrides a stock text size", () => {
    expect(cn("text-body-small", "text-label-medium")).toBe("text-label-medium");
    expect(cn("text-sm", "text-label-small")).toBe("text-label-small");
    for (const style of HOUSE_TYPE_STYLES) expect(cn("text-sm", `text-${style}`)).toBe(`text-${style}`);
  });

  test("colors still override each other and ordinary merging is unchanged", () => {
    expect(cn("text-foreground", "text-heat-100")).toBe("text-heat-100");
    expect(cn("h-8 rounded-lg border", "h-8 rounded-full border-0")).toBe("h-8 rounded-full border-0");
    expect(cn("px-2", false && "px-4", undefined, "py-1")).toBe("px-2 py-1");
  });
});
