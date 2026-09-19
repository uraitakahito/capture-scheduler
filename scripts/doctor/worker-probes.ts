/**
 * worker の中から叩いた curl の答えを読む —— container→api と worker→browserhive。
 *
 * 宛先に届くかは **flow が走る場所から** 見る。host から 7070 や 50051 に届いても、
 * コンテナから届くとは限らない (127.0.0.1 で待つ API は host からは答え、コンテナには
 * refused を返す)。
 *
 * curl には `-w '%{http_code} %{exitcode}'` を付け、終わり方を 2 つの数で受ける。
 * 2026-09-19 に worker の中で実測した終わり方:
 *
 *   BrowserHive の口 (HTTP/2 で GET)   415 0   gRPC は POST しか受けないが、答えるのは生きている証拠
 *   名前が引けない                     000 6   **止めたコンテナもこれ** —— 名前ごと消える (refused にならない)
 *   口が閉じている                     000 7
 *   答えない                           000 28  (--max-time の切れ)。**止めた直後の数秒もこれ** ——
 *                                              名前が消えるまでは、残った名前の先が答えない
 *
 * 入出力を持たない。curl を走らせるのは `checks.ts`。
 */
import type { Verdict } from "./run.js";

export interface CurlAnswer {
  /** HTTP の status。答えが無ければ "000"。 */
  http: string;
  /** curl の終わり方。0 が成功。 */
  rc: number;
}

/**
 * `container exec … curl -w '%{http_code} %{exitcode}'` の標準出力を読む。
 * 形が違えば undefined —— curl まで届いていない (worker のコンテナに入れなかった)。
 */
export const parseCurl = (stdout: string): CurlAnswer | undefined => {
  const match = /^(\d{3}) (\d+)$/.exec(stdout.trim());
  if (match === null) return undefined;
  return { http: match[1] ?? "000", rc: Number(match[2]) };
};

/** 落ちた口の終わり方ごとの言い方。知らない終わり方は rc をそのまま出す。 */
const DOWN: Readonly<Record<number, (endpoints: string) => string>> = {
  6: (endpoints) =>
    `名前が引けない: ${endpoints} —— コンテナが止まっている (cd ../capture-ledger && pnpm run stack:up) か、` +
    "変数 u/admin/browserhive_endpoints の綴り (CAPTURE_LEDGER_BROWSERHIVE_ENDPOINTS)",
  7: (endpoints) =>
    `待っていない: ${endpoints} —— BrowserHive が起動中か落ちた (コンテナは動いている)`,
  28: (endpoints) =>
    `3 秒で答えない: ${endpoints} —— 止めた直後 (名前が消えるまでの数秒) か、BrowserHive が詰まっている`,
};

/**
 * BrowserHive の口ごとの答え。答えれば status は問わない (gRPC の口に GET なので 415 が普通)。
 *
 * 落ちた口は、終わり方の同じものをまとめて名指しする —— 2 台とも止まっているときに、
 * 同じ直し方を 2 度読ませない。
 */
export const readBrowserhiveProbes = (
  probes: readonly { endpoint: string; answer: CurlAnswer }[],
): Verdict => {
  const down = new Map<number, string[]>();
  for (const { endpoint, answer } of probes) {
    if (answer.rc === 0 && answer.http !== "000") continue;
    down.set(answer.rc, [...(down.get(answer.rc) ?? []), endpoint]);
  }
  if (down.size === 0) return { ok: true };
  const parts = [...down].map(([rc, endpoints]) => {
    const say = DOWN[rc];
    return say === undefined
      ? `${endpoints.join("・")} → curl rc=${String(rc)}`
      : say(endpoints.join("・"));
  });
  return { ok: false, need: parts.join("。") };
};

/**
 * 段の報告の宛先 (変数 `u/admin/waggle_api_url`) の `/healthz`。
 *
 * **届かないときは、変数の宛先をいまの gateway と比べる。** 同じなのに refused なら、
 * gateway の口で待っているものが無い —— host からは答える API が 127.0.0.1 で待っている。
 * 違うなら、network を作り直して宛先が古くなった。この 2 つは curl の答えだけでは分けられない。
 */
export const readContainerApi = ({
  url,
  answer,
  expected,
}: {
  url: string;
  answer: CurlAnswer;
  /** いまの gateway から組んだ宛先 (`ledgerApiUrl`)。組めなければ undefined。 */
  expected: string | undefined;
}): Verdict => {
  if (answer.rc === 0 && answer.http === "200") return { ok: true };
  if (expected !== undefined && expected !== url) {
    return {
      ok: false,
      need:
        `変数の宛先 ${url} が、いまの gateway の ${expected} と違う (network を作り直した) → ` +
        "pnpm run windmill:capture-ledger-token",
    };
  }
  if (answer.rc === 7) {
    return {
      ok: false,
      need:
        `worker から ${url} に届かない (refused) —— API が 127.0.0.1 で待っている ` +
        "(CAPTURE_LEDGER_API_HOST=0.0.0.0 が効いていない) → " +
        "windmill:bootstrap が出した 4 行を capture-ledger の .env の末尾に貼り、API を起こし直す",
    };
  }
  if (answer.rc === 28) return { ok: false, need: `worker から ${url} が 5 秒で答えない` };
  if (answer.rc === 6) return { ok: false, need: `worker から ${url} の名前が引けない` };
  return {
    ok: false,
    need: `worker から ${url}/healthz → curl rc=${String(answer.rc)} http=${answer.http}`,
  };
};
