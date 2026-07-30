// /api/latest — screen.html（プロジェクター投影）用。公開・survey は絶対に含めない。
import { getLatestPublic } from "../../../lib/jobs-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const latest = await getLatestPublic();
    return Response.json(latest, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("[latest] GET failed:", e);
    return Response.json(null, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
