/**
 * 1 段ぶんの結果を capture-ledger に報告し、次の段があるかを受け取る。
 *
 * ## この 1 往復に判断が全部入っている
 *
 * こちらが送るのは「何が起きたか」だけ。範囲の絞り込みも、重複排除も、上限の判定も
 * capture-ledger が行う —— 方針は `crawls` の行に在り、重複排除は `crawl_pages` の unique index が
 * 持っているので、判断材料が両方あちらに在る。ここに写すと、2 か所が食い違ったときに
 * どちらが正しいのか言えなくなる。
 *
 * ## 次の段はこちらから起こさない
 *
 * `next` は返ってくるが、**それを使って次を起こすのは capture-ledger**。この flow は 1 段で
 * 終わる。Windmill の while ループに繰り返しを持たせようとしたが、`stop_after_if` を
 * 付けた最小の flow が 643 回まで回り続けた (実測) ので、暴走しうるループの上に
 * 「相手に負荷をかけない」仕組みを載せないことにした。
 *
 * 返り値は log と、この段が何をしたかの記録として残す。
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

export interface PageResult {
  url: string;
  status: "captured" | "failed" | "skipped";
  skipReason?: string;
  taskId?: string;
  correlationId?: string;
  submittedAt?: string;
  finishedAt?: string;
  linksLocation?: string;
  /** `.result.json` を書けた場所。`crawl_host.ts` の同名の欄を見ること。 */
  manifestLocation?: string;
  /** 書けなかった理由。taskId を持つ結果はこの 2 つのどちらか一方を持つ。 */
  manifestError?: string;
}

export interface NextPage {
  url: string;
  host: string;
  depth: number;
}

export interface LevelOutcome {
  next: NextPage[];
  stopReason: string | null;
}

/**
 * compile の段の出力 (`compile_scripts.ts` の Compiled)。台帳に運ぶのは JS の sha256 と、
 * 何で・何に向けて変換したかだけ —— source は運ばない。台帳が持つのは身元と hash で、
 * 中身は archive に在る。
 */
export interface CompiledLevel {
  typescript: string;
  hostTypes: string;
  scripts: { id: string; version: number; sha256: string }[];
}

export async function main(
  crawl_id: string,
  depth: number,
  results: PageResult[],
  compiled: CompiledLevel,
): Promise<LevelOutcome> {
  // **設定は変数から読む。引数では受けない。**
  // Windmill は schema の既定値を UI からの実行にしか埋めない (`crawl_host.ts` に詳しい)。
  // トークンは IdP (Cognito・手元は Floci) から段ごとに取る。capture-ledger からは送らない。
  const waggle_url = await wmill.getVariable("u/admin/waggle_api_url");
  const token = await ledgerToken();

  const res = await fetch(`${waggle_url}/api/crawls/${crawl_id}/pages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      depth,
      results,
      // 走った JS の hash と変換の記録。台帳は固定したスクリプトの各要素に写し、段ごとに同じ値かを見る
      // (違えば 409)。台帳側では必須 —— 載せ忘れは 400 で、この段が落ちる
      compiled: {
        typescript: compiled.typescript,
        hostTypes: compiled.hostTypes,
        scripts: compiled.scripts.map(({ id, version, sha256 }) => ({ id, version, sha256 })),
      },
    }),
  });

  if (!res.ok) {
    // 本文を必ず読む。status だけだと capture-ledger が返している理由が消える。
    const body = await res.text();
    const hint =
      res.status === 401
        ? " —— トークンが通らない (Floci のプールを作り直した後なら、capture-ledger で pnpm run dev:up --from idp)"
        : res.status === 404
          ? " —— トークンの sub (Windmill の app client の ID) に、その組織のクロールの許可がありますか" +
            " (capture-ledger: pnpm run idp:grant)"
          : "";
    throw new Error(
      `POST /api/crawls/${crawl_id}/pages → ${String(res.status)} ${body.slice(0, 300)}${hint}`,
    );
  }

  const outcome = (await res.json()) as LevelOutcome;
  console.log(
    `深さ ${String(depth)}: ${String(results.length)} 件を報告、次は ${String(outcome.next.length)} 件` +
      // 理由が付くのは終わったときだけ。`completed` は全部辿った印なので、「打ち切り」とは書かない
      (outcome.stopReason === null ? "" : ` (終わり: ${outcome.stopReason})`),
  );
  return outcome;
}
