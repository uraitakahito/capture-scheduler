/**
 * e2e が触る相手 —— capture-ledger の API・dev issuer・capture-fixtures・Windmill。
 *
 * 既存の試験 (`crawl-level.e2e.test.ts`) が自分の中に持っている既定と同じ物を、環境変数で差し替えられる形で
 * ここに置く。宛先が 2 つ要る理由もあちらと同じ: `FIXTURES` は**取り込む側** (BrowserHive のコンテナ) が引く
 * 名前で起点の URL に載り、`FIXTURES_HOST` は**この試験自身**が叩く loopback の口。macOS 26 では Apple 署名でない
 * バイナリ (node) がコンテナの subnet へ TCP を張れず、DNS 名は引けるのに `EHOSTUNREACH` になる (実測 2026-09-20)。
 */
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const WAGGLE = process.env["E2E_WAGGLE_URL"] ?? "http://127.0.0.1:7070";
export const ISSUER = process.env["E2E_ISSUER_URL"] ?? "http://127.0.0.1:9099";
export const FIXTURES =
  process.env["E2E_FIXTURES_URL"] ?? "http://capture-fixtures.capture-ledger:8080";
export const FIXTURES_HOST = process.env["E2E_FIXTURES_HOST_URL"] ?? "http://127.0.0.1:18085";
/** 取り込みを始められる主体。capture-ledger 側でクロールの許可 (`fga:grant submitter`) が要る。 */
export const SUBJECT = process.env["E2E_SUBJECT"] ?? "e2e";

/**
 * Windmill の口。doctor・smoke と同じく、この repo の `.env`・`.env.local` の `WINDMILL_*` で叩く。試験の process
 * にはどちらも読まれていないので、ここで読む。**`.env.local` が先**: `loadEnvFile` は既に在る値を上書きしないので、
 * 先に読んだ値が勝つ (`--env-file-if-exists=.env --env-file-if-exists=.env.local` と同じ勝ち方)。
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(fileURLToPath(new URL(`../../../${file}`, import.meta.url)));
  } catch {
    // 無ければ素通り。WINDMILL_TOKEN が要る試験だけが、無いと言って落ちる
  }
}
export const WINDMILL = process.env["WINDMILL_URL"] ?? "http://127.0.0.1:8000";
export const WORKSPACE = process.env["WINDMILL_WORKSPACE"] ?? "crawler";

export const windmillToken = (): string => {
  const token = process.env["WINDMILL_TOKEN"];
  expect(token, "WINDMILL_TOKEN が無い —— pnpm run windmill:bootstrap").toBeTruthy();
  return String(token);
};

export const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

/** issuer からトークンを採る。issuer は起動のたびに鍵を作り直すので、その場で。 */
export const mintToken = async (subject: string = SUBJECT): Promise<string> => {
  const res = await fetch(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject, organizations: ["acme"] }),
  });
  expect(res.ok, "issuer からトークンを採れませんでした").toBe(true);
  return String((await json(res))["access_token"]);
};

/** capture-fixtures の要求ログ。**query を含む URL ごと**に数える。 */
export const requestCounts = async (): Promise<Record<string, number>> =>
  (await json(await fetch(`${FIXTURES_HOST}/__request-counts`))) as Record<string, number>;

export const resetFixtures = async (): Promise<void> => {
  await fetch(`${FIXTURES_HOST}/__reset`, { method: "POST" });
};

/** 台帳の API を、採ったトークンで。 */
export const ledger = (token: string) => {
  const auth = { authorization: `Bearer ${token}` };

  /** `POST /api/crawls` の素の答え。断られ方を見る試験のため、status と本文をそのまま返す。 */
  const post = async (body: Record<string, unknown>): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${WAGGLE}/api/crawls`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };

  /** 1 本始めて crawlId を返す。202 でなければ、台帳の本文を理由に落とす。 */
  const start = async (body: Record<string, unknown>): Promise<string> => {
    const { status, text } = await post(body);
    expect(
      status,
      text +
        (status === 409
          ? " —— 走行中のクロールが残っています (この試験が途中で落ちると必ずこうなる)"
          : ""),
    ).toBe(202);
    return String((JSON.parse(text) as Record<string, unknown>)["crawlId"]);
  };

  const get = async (path: string): Promise<Record<string, unknown>> =>
    json(await fetch(`${WAGGLE}${path}`, { headers: auth }));

  /** 走り終えるまで待ち、`GET /api/crawls/:id` の答えを返す。 */
  const finished = async (crawlId: string): Promise<Record<string, unknown>> => {
    let got: Record<string, unknown> = { state: "running" };
    for (let i = 0; i < 100 && got["state"] === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      got = await get(`/api/crawls/${crawlId}`);
    }
    expect(got["state"], "クロールが終わらなかった").not.toBe("running");
    return got;
  };

  /**
   * この回の取り込みの archive。`GET /api/crawls/:id` は取り込んだページを返さないので、一覧 (新しい順) を
   * 起点の URL とクロールの開始時刻で絞る。行は段の報告の後に載るので、少し待つ (smoke と同じ 30 秒)。
   */
  const archiveOf = async (
    sourceUrl: string,
    startedAt: string,
  ): Promise<{ id: string; objectKey: string }> => {
    const since = Date.parse(startedAt);
    for (let i = 0; i < 30; i++) {
      const listed = await get("/api/archives");
      const found = (
        listed["archives"] as {
          id: string;
          sourceUrl: string;
          capturedAt: string;
          objectKey: string;
        }[]
      ).find((a) => a.sourceUrl === sourceUrl && Date.parse(a.capturedAt) >= since);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`台帳の一覧に ${sourceUrl} のこの回の archive が出ない`);
  };

  /** archive の署名付き URL。台帳が `POST /api/archives/:id/url` で出す。 */
  const signedUrl = async (archiveId: string): Promise<string> => {
    const res = await fetch(`${WAGGLE}/api/archives/${archiveId}/url`, {
      method: "POST",
      headers: auth,
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    return String(body["url"]);
  };

  return { post, start, get, finished, archiveOf, signedUrl };
};
