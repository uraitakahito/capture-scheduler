/**
 * 段が落ちたことを capture-ledger に伝え、クロールを締める。
 *
 * flow の `failure_module` から呼ばれる。**普通の段としては走らない。**
 *
 * ## なぜ要るのか
 *
 * flow が途中で落ちると `report_level` に辿り着かないので、capture-ledger は何も知らされない。
 * 行は `running` のまま残り、部分 unique index が**以後のクロールを全部塞ぐ**。
 * 実測で踏んだ: BrowserHive を止めてクロールを始めると、`crawl_host` が `UNAVAILABLE`
 * で落ちて flow ごと失敗し、行は永久に走行中になった。
 *
 * ## ここでは投げない
 *
 * 締めるのに失敗しても throw しない。**この段が赤くなっても意味が無い** —— flow は
 * どのみち既に失敗していて、Windmill の履歴にはその赤が残る。ここで重ねて投げると、
 * 「元の失敗」より「締められなかったこと」のほうが目立ってしまう。
 *
 * 締められなかったときは log に残す。行は `running` のまま残るが、それは
 * この段が無かったときと同じ状態で、悪化はしない。
 */
import * as wmill from "windmill-client";

// ── 台帳に名乗るトークン（6 本が同じ物を持つ。test/ledger-token.test.ts が同じかを見る）──
/**
 * 台帳 (capture-ledger) に名乗る access token を、client credentials で取る。
 *
 * 台帳の IdP は Amazon Cognito (手元は代役の Floci)。Windmill の flow は機械なので、人のサインインは
 * 使えず、app client の ID と secret で M2M のトークンを取る。トークンは最長 1 日しかもたないので、
 * 変数に入れて使い回さず、段ごとに取る。設定は変数 `u/admin/ledger_client` (secret・JSON) から読む
 * —— 入れるのは capture-scheduler の `pnpm run windmill:capture-ledger-token`。
 *
 * Windmill の relative import で 1 本にまとめないのは、この版の Windmill で効くかを確かめていないから。
 */
const ledgerToken = async (): Promise<string> => {
  const raw = await wmill.getVariable("u/admin/ledger_client");
  const client = JSON.parse(raw) as {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope: string;
  };
  const basic = btoa(`${client.clientId}:${client.clientSecret}`);
  const res = await fetch(client.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(client.scope)}`,
  });
  if (!res.ok) {
    throw new Error(
      `トークンを取れない: ${client.tokenUrl} → ${String(res.status)} ${(await res.text()).slice(0, 200)}` +
        " —— Floci のプールを作り直した後なら、capture-ledger で pnpm run dev:up --from idp",
    );
  }
  const { access_token: token } = (await res.json()) as { access_token?: unknown };
  if (typeof token !== "string" || token === "")
    throw new Error("token endpoint の答えに access_token が無い");
  return token;
};
// ── ここまで ──

export interface Result {
  closed: boolean;
  /** 締められなかったときの理由。締められたときは無い。 */
  problem?: string;
}

/** 誤りの中身を 1 行に潰す。Windmill が渡す形は step によって違う。 */
export const describe = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return String(error);
  const e = error as { message?: unknown; name?: unknown; step_id?: unknown };
  const message = typeof e.message === "string" ? e.message : JSON.stringify(error);
  // どの段で落ちたかは、あとから読むときにいちばん効く手がかり。
  return typeof e.step_id === "string" ? `[${e.step_id}] ${message}` : message;
};

/**
 * 台帳の reason の上限 (capture-ledger の `POST /api/crawls/:id/failed` の schema)。
 * **超えると 400 で断られ、行が running のまま次を全部 409 で塞ぐ** —— running の行を
 * 締めるのはこの段だけ。
 */
export const REASON_MAX = 2000;

/** 上限に収める。切ったら、何字省いたかを末尾に言う (切ったことを隠さない)。末尾のために 32 字空ける。 */
export const clip = (text: string, max = REASON_MAX): string => {
  if (text.length <= max) return text;
  const keep = max - 32;
  return `${text.slice(0, keep)}…（${String(text.length - keep)} 字を省いた）`;
};

export async function main(crawl_id: string, error: unknown): Promise<Result> {
  // **設定は変数から読む。** Windmill は schema の既定値を UI からの実行にしか
  // 埋めない —— webhook で起こすと引数は素通りになる (`crawl_host.ts` に詳しい)。
  const waggle_url = await wmill.getVariable("u/admin/waggle_api_url");
  const token = await ledgerToken();

  const reason = clip(describe(error));
  console.log(`クロール ${crawl_id} を締めます: ${reason}`);

  try {
    const res = await fetch(`${waggle_url}/api/crawls/${crawl_id}/failed`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      const body = await res.text();
      const problem = `POST /api/crawls/${crawl_id}/failed → ${String(res.status)} ${body.slice(0, 200)}`;
      console.log(`締められませんでした: ${problem}`);
      return { closed: false, problem };
    }
    const { closed } = (await res.json()) as { closed: boolean };
    console.log(closed ? "締めました" : "締めるものがありませんでした（既に終わっていた）");
    return { closed };
  } catch (err) {
    // capture-ledger に届かないこともある。**それでもこの段は緑で終える。**
    const problem = err instanceof Error ? err.message : String(err);
    console.log(`締められませんでした: ${problem}`);
    return { closed: false, problem };
  }
}
