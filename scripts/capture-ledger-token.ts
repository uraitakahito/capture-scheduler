#!/usr/bin/env node
/**
 * Windmill の flow が capture-ledger に名乗るための設定と、flow が読む宛先を、Windmill の変数に入れる。
 *
 *   pnpm run windmill:capture-ledger-token                  # ../capture-ledger から読む
 *   pnpm run windmill:capture-ledger-token ../floci-ledger  # 別の場所の capture-ledger (dev:up が渡す)
 *
 * ## トークンではなく、トークンを取る資格を入れる
 *
 * capture-ledger の IdP は Amazon Cognito (手元は代役の Floci。CAPTURE-185)。Cognito の access token は最長 1 日しか
 * もたないので、以前のように 30 日のトークンを 1 本入れて使い回す形は取れない。入れるのは app client の
 * ID と secret で、flow は段ごとに client credentials でトークンを取る (`windmill/f/waggle/` の `ledgerToken`)。
 *
 * 値を決めるのは capture-ledger の `pnpm run idp:bootstrap`。こちらは向こうの引き渡しファイル
 * (`.dev/idp.env`) を **読みに行く** —— 書くのは自分の repo (と Windmill) だけ、跨ぐときは読むだけ。
 *
 * ## 再実行が要るとき
 *
 * Floci はプールをメモリに持つ。capture-ledger のスタックを作り直すとプールが消え、client の ID も secret も
 * 替わる。capture-ledger の `pnpm run dev:up` (段 idp と token) が両方を打ち直す。
 */
import {
  guardEnv,
  ledgerApiUrl,
  optional,
  tsCompileUrl,
  windmillFetch,
  windmillWorkspace,
} from "./env.js";
import {
  LEDGER_CLIENT_VAR,
  RETIRED_TOKEN_VAR,
  hostClientCredentials,
  ledgerClientFrom,
  ledgerDir,
  readIdpHandoff,
} from "./ledger-client.js";

guardEnv();

const LEDGER = ledgerDir(process.argv[2]);
/**
 * browserhive のエンドポイント (URL)。**browser 1 台にエンドポイント 1 つなので複数**。カンマ区切りで受け、
 * 変数には JSON 配列で入れる (Windmill の変数は文字列なので、形を 1 つに決めておく)。
 * 空いているエンドポイントを選ぶのは `crawl_host` で、並列度の上限にするのは `plan_level`。
 *
 * BrowserHive v12 からエンドポイントは HTTP なので `http(s)://` の URL。v11 までの `host:port` は
 * ここで止める —— `crawl_host` が読むまで待つと、変数を入れた後で気づくことになる。
 */
const BROWSERHIVE_ENDPOINTS = optional(
  "CAPTURE_LEDGER_BROWSERHIVE_ENDPOINTS",
  "http://browserhive-1.capture-ledger:50051,http://browserhive-2.capture-ledger:50051",
)
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
for (const endpoint of BROWSERHIVE_ENDPOINTS) {
  if (!/^https?:\/\//.test(endpoint)) {
    throw new Error(
      `CAPTURE_LEDGER_BROWSERHIVE_ENDPOINTS は http(s):// の URL にしてください (BrowserHive v12 から HTTP): ${endpoint}`,
    );
  }
}
const URL_PATH = "u/admin/waggle_api_url";
/**
 * **Windmill の script は変数からしか読めない** —— schema の既定値は UI からの実行にしか
 * 埋まらないので、webhook で起こすと引数は素通りになる (実測)。だから設定は変数に置く。
 */
const ENDPOINTS_PATH = "u/admin/browserhive_endpoints";
/**
 * browserhive のエンドポイントを HTTPS にするときの CA 証明書 (PEM)。
 *
 * **空文字は「TLS を使わない」**。変数そのものを作らない選択にしなかったのは、
 * `getVariable` が「無い」で落ちるのと「空だった」を script 側で区別すると、
 * 読み取りの失敗が黙って平文に落ちる経路になるから。空で置いておけば、
 * TLS のつもりの配備が平文で喋ることはない。開発のスタックは平文。
 */
const TLS_CA_PATH = "u/admin/browserhive_tls_ca";
const TLS_CA_PEM = optional("CAPTURE_LEDGER_BROWSERHIVE_TLS_CA_PEM", "");
/** TS のスクリプトを JS にする変換サービス。flow の `compile` の段が読む。 */
const TS_COMPILE_PATH = "u/admin/ts_compile_url";
const TS_COMPILE_URL = tsCompileUrl();

/**
 * 変数を作るか、あれば上書きする。
 *
 * Windmill の create は既にある path を 400 で拒むので、「作る → 駄目なら更新」
 * の順で試す。逆順 (更新 → 駄目なら作る) にしないのは、初回の一番よくある道で
 * 必ず 404 を 1 回踏むことになるため。
 */
const upsertVariable = async (
  token: string,
  path: string,
  value: string,
  isSecret: boolean,
): Promise<string> => {
  const workspace = windmillWorkspace();
  const body = { path, value, is_secret: isSecret, description: "capture-scheduler が設定" };
  try {
    await windmillFetch(`/api/w/${workspace}/variables/create`, {
      token,
      method: "POST",
      body,
    });
    return "作成";
  } catch {
    await windmillFetch(`/api/w/${workspace}/variables/update/${path}`, {
      token,
      method: "POST",
      body,
    });
    return "更新";
  }
};

/** 前の形の変数を消す。無ければ何もしない。消したら true。 */
const retireVariable = async (token: string, path: string): Promise<boolean> => {
  const workspace = windmillWorkspace();
  try {
    await windmillFetch(`/api/w/${workspace}/variables/delete/${path}`, {
      token,
      method: "DELETE",
    });
    return true;
  } catch {
    return false;
  }
};

const main = async () => {
  const windmillToken = process.env["WINDMILL_TOKEN"];
  if (windmillToken === undefined || windmillToken === "") {
    throw new Error(
      "WINDMILL_TOKEN is not set —— pnpm run windmill:bootstrap の出力を .env に貼ってください",
    );
  }

  const handoff = readIdpHandoff(LEDGER);
  if (handoff === undefined) {
    throw new Error(
      `${LEDGER}/.dev/idp.env が無い —— capture-ledger で pnpm run idp:bootstrap (dev:up の段 idp) を先に。` +
        "別の場所の capture-ledger なら、その場所を引数に渡す",
    );
  }
  const client = ledgerClientFrom(handoff);
  // 入れる前に、その資格でトークンが取れることを確かめる。取れない資格を入れると、flow の段が 1 つずつ落ちる。
  const probe = await hostClientCredentials(client);
  if (probe.token === undefined) {
    throw new Error(
      `${client.hostTokenUrl} でトークンを取れない (${String(probe.status ?? "届かない")} ${probe.body.slice(0, 200)})` +
        " —— capture-ledger で pnpm run dev:up --from idp",
    );
  }
  const clientAction = await upsertVariable(
    windmillToken,
    LEDGER_CLIENT_VAR,
    JSON.stringify(client),
    true,
  );
  const retired = await retireVariable(windmillToken, RETIRED_TOKEN_VAR);
  // 1 度だけ決める。既定は default ネットワークの gateway を訊く (`env.ts` の `ledgerApiUrl`)。
  const apiUrl = ledgerApiUrl();
  const apiUrlFrom =
    optional("CAPTURE_LEDGER_API_URL", "") === "" ? " —— default ネットワークの gateway から" : "";
  const urlAction = await upsertVariable(windmillToken, URL_PATH, apiUrl, false);
  const endpointsAction = await upsertVariable(
    windmillToken,
    ENDPOINTS_PATH,
    JSON.stringify(BROWSERHIVE_ENDPOINTS),
    false,
  );
  const tlsAction = await upsertVariable(windmillToken, TLS_CA_PATH, TLS_CA_PEM, false);
  const tsCompileAction = await upsertVariable(
    windmillToken,
    TS_COMPILE_PATH,
    TS_COMPILE_URL,
    false,
  );

  process.stderr.write(
    `${LEDGER_CLIENT_VAR} を${clientAction} (client ${client.clientId}・iss ${client.issuer}・` +
      `flow は ${client.tokenUrl} で取る)\n` +
      (retired ? `${RETIRED_TOKEN_VAR} (前の形の 30 日のトークン) を消した\n` : "") +
      `${URL_PATH} を${urlAction} (${apiUrl}${apiUrlFrom})\n` +
      `${ENDPOINTS_PATH} を${endpointsAction} (${BROWSERHIVE_ENDPOINTS.join(", ")})\n` +
      `${TLS_CA_PATH} を${tlsAction} (${TLS_CA_PEM === "" ? "空 = 平文" : "CA あり"})\n` +
      `${TS_COMPILE_PATH} を${tsCompileAction} (${TS_COMPILE_URL})\n\n` +
      "flow の app client には、組織のクロールの許可が要る (1 度だけ。済んだかは pnpm run doctor の can_submit が言う):\n" +
      "  cd ../capture-ledger && pnpm run idp:grant\n",
  );
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
