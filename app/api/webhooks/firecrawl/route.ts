import { NextResponse } from "next/server";

/** Retired vendor endpoint. Native monitors are driven by authenticated local cron checks. */
export async function POST(_request: Request) {
  return NextResponse.json(
    { error: "Vendor webhooks are retired. Recreate monitors in Presets for native scheduled checks." },
    { status: 410 },
  );
}
