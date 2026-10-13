import type { MetadataRoute } from "next";
import { cacheLife } from "next/cache";
import { connection } from "next/server";
import { isLanding } from "@/lib/access";
import { db } from "@/lib/db";
import { canonicalBase } from "@/lib/origin";
import { buildSitemap, sitemapEntities } from "@/lib/seo";

/**
 * The entity reads, cached for the hour in the platform's shared cache: a crawler fetching the
 * sitemap costs two grouped queries an hour at most, never one per page or per cold function
 * instance. Taking no handle keeps the cache key empty.
 */
async function entities() {
  "use cache: remote";
  cacheLife("hours");
  return sitemapEntities(await db());
}

/**
 * Every public page: the front door, the four indexes, and each company and investor the feed
 * names. connection() keeps it off the build, like every page here: a build has no store to read.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  return buildSitemap(canonicalBase(), isLanding(), await entities());
}
