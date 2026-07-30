// GET /api/my/[token] — 印刷 QR の飛び先(#my/<token>)が参照する公開エンドポイント。
// トークン(推測不能なクライアント生成乱数)から選ばれた3作品を解決する。
// survey・spec は返さない。存在しないトークンは 404。
import { NextRequest, NextResponse } from "next/server";
import { getMyPublic } from "../../../../lib/jobs-store";

const TOKEN_RE = /^[A-Za-z0-9]{10,32}$/;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params;
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }
  const my = await getMyPublic(token);
  if (!my) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(my, {
    headers: { "Cache-Control": "no-store" },
  });
}
