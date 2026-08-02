export async function GET() {
  try {
    await fetch("https://example.com/task-1-canary?secret=must-not-leak");
    return Response.json({ blocked: false, code: null }, { status: 500 });
  } catch (error) {
    return Response.json({
      blocked: error?.code === "LOCAL_DEMO_EGRESS_BLOCKED",
      code: error?.code ?? null,
      guardMarker: globalThis.__SCANBIN_LOCAL_DEMO_EGRESS_GUARD__ ?? null,
    });
  }
}
