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

// ── capture-ledger に名乗るトークン（6 本が同じ物を持つ。test/ledger-token.test.ts が同じかを見る）──
/**
 * capture-ledger に名乗る access token を、client credentials で取る。
 *
 * capture-ledger の IdP は Amazon Cognito (手元は代役の Floci)。Windmill の flow は機械なので、人のサインインは
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
 * capture-ledger の reason の上限 (capture-ledger の `POST /api/crawls/:id/failed` の schema)。
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

/** 5xx と繋がらないときの、この段の中の試み (初回を含む)。failure_module の再試行は確かめていないので頼らない。 */
export const CLOSE_ATTEMPTS = 3;
/** 試みの間 (ms)。 */
export const CLOSE_RETRY_MS = 5_000;

/**
 * 締める要求を送る。5xx と繋がらないときは、間を空けて `CLOSE_ATTEMPTS` 回まで試す (起こし直している capture-ledger)。
 * 4xx は試し直しても同じ答え (トークン・許可・本文の形) なので 1 回で止める。**投げない。**
 *
 * `main` から切り出してあるのは試験のため (`main` は Windmill の変数を読むので単体では回せない)。`main` の引数に
 * 試験の部品を足すと、Windmill はそれを flow の入力として schema に載せる。
 */
export const sendClose = async (
  send: () => Promise<Response>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Result> => {
  let problem = "";
  for (let attempt = 1; attempt <= CLOSE_ATTEMPTS; attempt += 1) {
    try {
      const res = await send();
      if (res.ok) {
        const { closed } = (await res.json()) as { closed: boolean };
        console.log(
          closed
            ? "締めました"
            : "締めませんでした（既に終わっていた・一番新しい段の失敗ではなかった）",
        );
        return { closed };
      }
      const body = await res.text();
      problem = `→ ${String(res.status)} ${body.slice(0, 200)}`;
      if (res.status < 500) break;
    } catch (err) {
      // capture-ledger に届かない (起こし直している途中など)
      problem = err instanceof Error ? err.message : String(err);
    }
    if (attempt < CLOSE_ATTEMPTS) {
      console.log(`締められませんでした (${String(attempt)} 回目): ${problem}。試し直します`);
      await sleep(CLOSE_RETRY_MS);
    }
  }
  // **それでもこの段は緑で終える。** flow はどのみち既に失敗していて、その赤が履歴に残る。
  console.log(`締められませんでした: ${problem}`);
  return { closed: false, problem };
};

export async function main(
  crawl_id: string,
  /** 落ちた段の深さ (CAPTURE-180)。capture-ledger は一番新しい段のときだけ締める */
  depth: number,
  /** 落ちた段の鍵 (flow の引数で届いた物をそのまま) */
  level_key: string,
  error: unknown,
): Promise<Result> {
  // **設定は変数から読む。** Windmill は schema の既定値を UI からの実行にしか
  // 埋めない —— webhook で起こすと引数は素通りになる (`crawl_host.ts` に詳しい)。
  const waggle_url = await wmill.getVariable("u/admin/waggle_api_url");
  const token = await ledgerToken();

  const reason = clip(describe(error));
  console.log(`クロール ${crawl_id} の段 ${String(depth)} を締めます: ${reason}`);
  return sendClose(() =>
    fetch(`${waggle_url}/api/crawls/${crawl_id}/failed`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // 段と段の鍵を付ける。古い段の flow の失敗なら、capture-ledger は締めずに {closed: false} で答える
      body: JSON.stringify({ reason, depth, levelKey: level_key }),
    }),
  );
}
