// /api/print-jobs — マイリーフレットのジョブ受付（visit.html）＋ print-agent 向け一覧取得。
//
// POST: 公開。バリデーションして保存し { id } を返す。1 IP あたり 5 秒 1 回のレート制限。
// GET : print-agent 専用。x-agent-token が PRINT_AGENT_TOKEN と一致必須（未設定時は開発用に許可）。
//       ?after=<id> より新しいジョブを [{id, meta, frontUrl}] で返す。
//       front.jpg は private Blob なので直リンクを返さず ?front=<id> で本体を返す（要トークン）。
import { saveJob, listJobsAfter, readFront, StorageNotConfiguredError, type JobInput, type Survey } from "../../../lib/jobs-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WORK_ID_RE = /^w\d{2}$/;
// assets/visit/graphic.js の EMOTIONS.key と同期（キー一覧はここでは検証専用に複製）
const EMOTION_KEYS = new Set([
  "wakuwaku", "odayaka", "ureshii", "jinwari", "sukkiri", "natsukashii", "shinmiri",
]);
const MAX_FRONT_BYTES = 3.8 * 1024 * 1024;
const RATE_LIMIT_MS = 5000;

// 素朴なメモリ内レート制限（プロセス内のみ・複数インスタンスには非対応）
const lastRequestAtByIp = new Map<string, number>();

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function trimmed(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length <= maxLen ? s : null;
}

function validateBody(body: unknown): { ok: true; job: JobInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid body" };
  const b = body as Record<string, unknown>;

  if (b.v !== 1) return { ok: false, error: "invalid v" };

  const spec = b.spec;
  if (
    typeof spec !== "object" ||
    spec === null ||
    !Array.isArray((spec as Record<string, unknown>).blobs) ||
    (spec as { blobs: unknown[] }).blobs.length !== 3
  ) {
    return { ok: false, error: "invalid spec" };
  }

  const workIds = b.workIds;
  if (
    !Array.isArray(workIds) ||
    workIds.length !== 3 ||
    !workIds.every((w) => typeof w === "string" && WORK_ID_RE.test(w))
  ) {
    return { ok: false, error: "invalid workIds" };
  }

  const emotion = trimmed(b.emotion, 30);
  if (!emotion || !EMOTION_KEYS.has(emotion)) return { ok: false, error: "invalid emotion" };

  const surveyRaw = b.survey;
  if (typeof surveyRaw !== "object" || surveyRaw === null) return { ok: false, error: "invalid survey" };
  const s = surveyRaw as Record<string, unknown>;
  const visit = trimmed(s.visit, 100);
  const who = trimmed(s.who, 100);
  const comment = trimmed(s.comment, 2000);
  const satisfaction = s.satisfaction;
  if (visit === null || who === null || comment === null) return { ok: false, error: "invalid survey text" };
  if (typeof satisfaction !== "number" || !Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 5) {
    return { ok: false, error: "invalid satisfaction" };
  }
  const survey: Survey = { visit, who, satisfaction, comment };

  const front = b.front;
  if (typeof front !== "string" || !front.startsWith("data:image/jpeg;base64,")) {
    return { ok: false, error: "invalid front" };
  }
  const base64Len = front.length - "data:image/jpeg;base64,".length;
  // base64 は元データの約 4/3 倍。厳密なデコード前に大まかに弾く（デコードは1回で済ませる）
  if (base64Len * 0.75 > MAX_FRONT_BYTES * 1.05) return { ok: false, error: "front too large" };

  // QR トークン（クライアント生成の乱数文字列。印刷前に QR に焼き込むためサーバー採番にしない）
  const token = b.token;
  if (typeof token !== "string" || !/^[A-Za-z0-9]{10,32}$/.test(token)) {
    return { ok: false, error: "invalid token" };
  }

  return {
    ok: true,
    job: { v: 1, spec, workIds: workIds as [string, string, string], emotion, survey, front, token },
  };
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  const now = Date.now();
  const last = lastRequestAtByIp.get(ip);
  if (last && now - last < RATE_LIMIT_MS) {
    return Response.json({ error: "too many requests" }, { status: 429 });
  }
  lastRequestAtByIp.set(ip, now);

  let body: unknown;
  try {
    body = await req.json();
  } catch (e) {
    console.error("[print-jobs] JSON parse failed:", e);
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const validated = validateBody(body);
  // 注: boolean リテラルの判別子は truthy チェックでは絞り込まれないため === で比較する
  if (validated.ok === false) {
    return Response.json({ error: validated.error }, { status: 400 });
  }

  try {
    const { id } = await saveJob(validated.job);
    return Response.json({ id });
  } catch (e) {
    console.error("[print-jobs] saveJob failed:", e);
    if (e instanceof StorageNotConfiguredError) {
      // 設定漏れ（Blob 未接続）は 503 で、原因が分かるメッセージを返す
      return Response.json({ error: e.message }, { status: 503 });
    }
    return Response.json({ error: "save failed" }, { status: 500 });
  }
}

function checkAgentToken(req: Request): boolean {
  const expected = process.env.PRINT_AGENT_TOKEN;
  if (!expected) {
    console.warn("[print-jobs] PRINT_AGENT_TOKEN 未設定 — 開発用に認証なしで許可します");
    return true;
  }
  return req.headers.get("x-agent-token") === expected;
}

export async function GET(req: Request) {
  if (!checkAgentToken(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);

  // front.jpg 本体の取得（Blob / ローカルどちらも通る）
  const frontId = url.searchParams.get("front");
  if (frontId) {
    const buf = await readFront(frontId);
    if (!buf) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(buf), { headers: { "Content-Type": "image/jpeg" } });
  }

  try {
    const afterId = url.searchParams.get("after");
    const jobs = await listJobsAfter(afterId);
    // Blob は private なので直リンクは返さない。この API 自身の ?front=（トークン必須）に差し替える
    const out = jobs.map((j) => ({
      ...j,
      frontUrl: j.frontUrl ?? `${url.origin}/api/print-jobs?front=${j.id}`,
    }));
    return Response.json(out);
  } catch (e) {
    console.error("[print-jobs] GET failed:", e);
    return Response.json({ error: "list failed" }, { status: 500 });
  }
}
