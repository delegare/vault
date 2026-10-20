import { NextResponse } from "next/server";

// Proxy route for mpp.dev/api/services — their API blocks fetches
// without a browser User-Agent. Also used as the canonical MPP data
// source so getAllServices() can call this same URL regardless of context.
export async function GET() {
  try {
    const res = await fetch("https://mpp.dev/api/services", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://mpp.dev/",
        "Origin": "https://mpp.dev",
      },
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      return NextResponse.json({ services: [] }, { status: 200 });
    }

    const data = await res.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch {
    return NextResponse.json({ services: [] }, { status: 200 });
  }
}
