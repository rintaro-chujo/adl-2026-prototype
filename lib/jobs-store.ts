// lib/jobs-store.ts — マイリーフレットジョブの永続化。
//
// BLOB_READ_WRITE_TOKEN があれば Vercel Blob（jobs/{id}/meta.json, jobs/{id}/front.jpg, latest.json）、
// なければローカル開発フォールバックとして .data/ 以下に fs で読み書きする。
// visit/screen/print-agent はここを直接 import せず、API（app/api/*）経由でのみ触れる。
//
// 注意: トークンの有無はリクエスト処理時に都度 process.env を見て判定する（遅延評価）。
// モジュールのトップレベルで throw させると next build 時に落ちるため避ける。

import { put, list } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";

export type Survey = {
  visit: string;
  who: string;
  satisfaction: number;
  comment: string;
};

// POST /api/print-jobs のリクエストボディ（front を含む）
export type JobInput = {
  v: 1;
  spec: unknown;
  workIds: [string, string, string];
  emotion: string;
  survey: Survey;
  front: string; // data:image/jpeg;base64,...
  // QR 用の推測不能トークン（クライアント生成、印刷前に QR に焼き込むため）。
  // #my/<token> → 3作品の解決にだけ使い、survey には決して紐づけて公開しない
  token: string;
};

// GET /api/my/[token] の公開ビュー。survey・spec は含めない
export type MyPublic = {
  workIds: [string, string, string];
  emotion: string;
  createdAt: number;
};

// front を除いたジョブ本体（print-agent の GET が受け取る meta）
export type JobMeta = {
  v: 1;
  id: string;
  createdAt: number;
  spec: unknown;
  workIds: [string, string, string];
  emotion: string;
  survey: Survey;
};

// screen.html 用の公開ビュー。survey は絶対に含めない。
export type LatestPublic = {
  id: string;
  createdAt: number;
  spec: unknown;
  workIds: [string, string, string];
  emotion: string;
};

export type JobListItem = { id: string; meta: JobMeta; frontUrl: string | null };

const LOCAL_DIR = path.join(process.cwd(), ".data");

function useBlob(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

// 本番（Vercel）のファイルシステムは読み取り専用なので .data フォールバックは使えない。
// Blob 未接続のまま公開されたときに原因が分かるよう、書き込み前に明示的に落とす。
export class StorageNotConfiguredError extends Error {
  constructor() {
    super(
      "BLOB_READ_WRITE_TOKEN が未設定です。Vercel ダッシュボードで Blob ストアを作成し、" +
        "このプロジェクトに接続してから再デプロイしてください。"
    );
    this.name = "StorageNotConfiguredError";
  }
}

function assertWritable(): void {
  if (!useBlob() && process.env.VERCEL) throw new StorageNotConfiguredError();
}

function genId(): string {
  const rand = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `${Date.now()}-${rand}`;
}

function decodeFrontDataUrl(front: string): Buffer {
  const comma = front.indexOf(",");
  return Buffer.from(front.slice(comma + 1), "base64");
}

// ---------- 保存 ----------
export async function saveJob(input: JobInput): Promise<{ id: string }> {
  assertWritable();
  const id = genId();
  const createdAt = Date.now();
  const meta: JobMeta = {
    v: 1,
    id,
    createdAt,
    spec: input.spec,
    workIds: input.workIds,
    emotion: input.emotion,
    survey: input.survey,
  };
  const latest: LatestPublic = {
    id,
    createdAt,
    spec: input.spec,
    workIds: input.workIds,
    emotion: input.emotion,
  };
  const frontBuf = decodeFrontDataUrl(input.front);
  // QR トークン → 3作品 の解決レコード（公開可能な情報のみ）
  const my: MyPublic = {
    workIds: input.workIds,
    emotion: input.emotion,
    createdAt,
  };

  if (useBlob()) {
    await Promise.all([
      put(`jobs/${id}/meta.json`, JSON.stringify(meta), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      }),
      put(`jobs/${id}/front.jpg`, frontBuf, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "image/jpeg",
      }),
      put(`latest.json`, JSON.stringify(latest), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      }),
      put(`tokens/${input.token}.json`, JSON.stringify(my), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      }),
    ]);
  } else {
    const dir = path.join(LOCAL_DIR, "jobs", id);
    const tokDir = path.join(LOCAL_DIR, "tokens");
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(tokDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta)),
      fs.writeFile(path.join(dir, "front.jpg"), frontBuf),
      fs.writeFile(path.join(LOCAL_DIR, "latest.json"), JSON.stringify(latest)),
      fs.writeFile(path.join(tokDir, `${input.token}.json`), JSON.stringify(my)),
    ]);
  }
  return { id };
}

// ---------- QR トークンの解決（#my/<token> 用） ----------
export async function getMyPublic(token: string): Promise<MyPublic | null> {
  if (useBlob()) {
    try {
      const { blobs } = await list({ prefix: `tokens/${token}.json`, limit: 1 });
      if (blobs.length === 0) return null;
      return (await fetch(blobs[0].url).then((r) => r.json())) as MyPublic;
    } catch (e) {
      console.error("[jobs-store] token 取得失敗:", e);
      return null;
    }
  }
  try {
    const raw = await fs.readFile(path.join(LOCAL_DIR, "tokens", `${token}.json`), "utf8");
    return JSON.parse(raw) as MyPublic;
  } catch {
    return null;
  }
}

// ---------- print-agent 用の一覧取得 ----------
export async function listJobsAfter(afterId: string | null): Promise<JobListItem[]> {
  if (useBlob()) {
    const { blobs } = await list({ prefix: "jobs/" });
    const frontUrlById = new Map<string, string>();
    for (const b of blobs) {
      if (b.pathname.endsWith("/front.jpg")) {
        frontUrlById.set(b.pathname.split("/")[1], b.url);
      }
    }
    const metaRefs = blobs
      .filter((b) => b.pathname.endsWith("/meta.json"))
      .map((b) => ({ id: b.pathname.split("/")[1], url: b.url }))
      .filter((x) => !afterId || x.id > afterId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const out: JobListItem[] = [];
    for (const ref of metaRefs) {
      try {
        const meta = (await fetch(ref.url).then((r) => r.json())) as JobMeta;
        out.push({ id: ref.id, meta, frontUrl: frontUrlById.get(ref.id) ?? null });
      } catch (e) {
        console.error(`[jobs-store] meta.json 取得失敗 id=${ref.id}:`, e);
      }
    }
    return out;
  }

  // ローカル開発フォールバック
  const jobsDir = path.join(LOCAL_DIR, "jobs");
  let dirents: string[] = [];
  try {
    dirents = (await fs.readdir(jobsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const ids = dirents.filter((id) => !afterId || id > afterId).sort();
  const out: JobListItem[] = [];
  for (const id of ids) {
    try {
      const raw = await fs.readFile(path.join(jobsDir, id, "meta.json"), "utf8");
      out.push({ id, meta: JSON.parse(raw) as JobMeta, frontUrl: null });
    } catch (e) {
      console.error(`[jobs-store] meta.json 読み込み失敗 id=${id}:`, e);
    }
  }
  return out;
}

// ローカル開発フォールバック時、front.jpg の実体を返す（Blob 利用時は frontUrl を直接使うので不要）
export async function readLocalFront(id: string): Promise<Buffer | null> {
  if (useBlob()) return null;
  try {
    return await fs.readFile(path.join(LOCAL_DIR, "jobs", id, "front.jpg"));
  } catch {
    return null;
  }
}

// ---------- screen.html 用の最新ジョブ ----------
export async function getLatestPublic(): Promise<LatestPublic | null> {
  if (useBlob()) {
    try {
      const { blobs } = await list({ prefix: "latest.json", limit: 1 });
      if (blobs.length === 0) return null;
      return (await fetch(blobs[0].url).then((r) => r.json())) as LatestPublic;
    } catch (e) {
      console.error("[jobs-store] latest.json 取得失敗:", e);
      return null;
    }
  }
  try {
    const raw = await fs.readFile(path.join(LOCAL_DIR, "latest.json"), "utf8");
    return JSON.parse(raw) as LatestPublic;
  } catch {
    return null;
  }
}
