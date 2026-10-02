import { directUrl, driverFor } from "@fireround/core/db";
import { describe, expect, test } from "vitest";

describe("directUrl", () => {
  test("a Neon pooler URL reaches the same endpoint's direct host, credentials and options untouched", () => {
    const pooled =
      "postgresql://app:p%40ss@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
    expect(directUrl(pooled)).toBe(
      "postgresql://app:p%40ss@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    );
    expect(driverFor(directUrl(pooled))).toBe("neon");
  });

  test("a PlanetScale PgBouncer URL (port 6432, or a |bouncer user) reaches Postgres on 5432 as the plain role", () => {
    const pooled = "postgresql://postgres.abc123:pscale_pw_x%2Fy@abc123-useast1-1.horizon.psdb.cloud:6432/fireround?sslmode=verify-full";
    const direct = "postgresql://postgres.abc123:pscale_pw_x%2Fy@abc123-useast1-1.horizon.psdb.cloud:5432/fireround?sslmode=verify-full";
    expect(directUrl(pooled)).toBe(direct);
    expect(directUrl("postgresql://postgres.abc123%7Cwrite-pool:pw@abc123-useast1-1.horizon.psdb.cloud:6432/fireround")).toBe(
      "postgresql://postgres.abc123:pw@abc123-useast1-1.horizon.psdb.cloud:5432/fireround",
    );
    expect(directUrl(direct)).toBe(direct);
    expect(driverFor(direct)).toBe("pg");
  });

  test("a direct Neon URL, any other host, and a string that is no URL come back as given", () => {
    const direct = "postgresql://app:secret@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require";
    expect(directUrl(direct)).toBe(direct);
    expect(directUrl("postgres://u:p@db-pooler.example.com/app")).toBe("postgres://u:p@db-pooler.example.com/app");
    expect(directUrl("not a url")).toBe("not a url");
  });
});
