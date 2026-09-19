#!/usr/bin/env node
/**
 * capture-ledger の dev issuer からトークンを取り、Windmill の secret 変数に入れる。
 *
 * ## なぜ Windmill 自身に取りに行かせないのか
 *
 * dev issuer は **頼まれれば誰の名前でもトークンを出す**。だから届く範囲がそのまま
 * 「誰を名乗れるか」になる。コンテナから引けるところに置いた瞬間、ブリッジに届く
 * 誰もが `windmill` を名乗れる —— つまり `submitter` の付与を回り込める。
 * ヘッダを信じる方式をやめた意味が消える。
 *
 * だから鍵を作る力は host の loopback に残す。ここを跨ぐのは**出来上がった
 * トークン 1 本**だけ。issuer は `127.0.0.1` のまま動かすこと。
 *
 * ## 再実行が要るとき
 *
 * issuer は起動のたびにメモリ上で鍵を作り直す (意図された挙動 —— 鍵の更新を
 * 再現できる)。**issuer を再起動したら、このスクリプトも実行し直すこと。**
 * 古いトークンは 401 になる。
 */
import { guardEnv, optional, ledgerApiUrl, windmillFetch, windmillWorkspace } from "./env.js";

guardEnv();

const ISSUER = optional("CAPTURE_LEDGER_OIDC_ISSUER", "http://127.0.0.1:9099");
const SUBJECT = optional("CAPTURE_LEDGER_SUBJECT", "windmill");
/**
 * browserhive の gRPC の宛先。**browser 1 台に口 1 つなので複数**。カンマ区切りで受け、
 * 変数には JSON 配列で入れる (Windmill の変数は文字列なので、形を 1 つに決めておく)。
 * 空いている口を選ぶのは `crawl_host` で、並列度の上限にするのは `plan_level`。
 */
const BROWSERHIVE_ENDPOINTS = optional(
  "CAPTURE_LEDGER_BROWSERHIVE_ENDPOINTS",
  "browserhive-1.capture-ledger:50051,browserhive-2.capture-ledger:50051",
)
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const ORGANIZATIONS = optional("CAPTURE_LEDGER_ORGANIZATIONS", "acme")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const EXPIRES_IN = optional("CAPTURE_LEDGER_TOKEN_EXPIRES_IN", "30d");

const TOKEN_PATH = "u/admin/waggle_token";
const URL_PATH = "u/admin/waggle_api_url";
/**
 * **Windmill の script は変数からしか読めない** —— schema の既定値は UI からの実行にしか
 * 埋まらないので、webhook で起こすと引数は素通りになる (実測)。だから設定は変数に置く。
 */
const ENDPOINTS_PATH = "u/admin/browserhive_endpoints";
/**
 * browserhive の gRPC を TLS にするときの CA 証明書 (PEM)。
 *
 * **空文字は「TLS を使わない」**。変数そのものを作らない選択にしなかったのは、
 * `getVariable` が「無い」で落ちるのと「空だった」を script 側で区別すると、
 * 読み取りの失敗が黙って平文に落ちる経路になるから。空で置いておけば、
 * TLS のつもりの配備が平文で喋ることはない。開発のスタックは平文。
 */
const TLS_CA_PATH = "u/admin/browserhive_tls_ca";
const TLS_CA_PEM = optional("CAPTURE_LEDGER_BROWSERHIVE_TLS_CA_PEM", "");

const mintToken = async () => {
  const res = await fetch(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subject: SUBJECT,
      organizations: ORGANIZATIONS,
      expiresIn: EXPIRES_IN,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${ISSUER}/token → ${String(res.status)} ${text.slice(0, 200)}\n` +
        "  issuer は動いていますか (cd ../capture-ledger && pnpm run oidc:issuer)",
    );
  }
  const parsed = JSON.parse(text);
  const token = parsed.access_token ?? parsed.token ?? parsed.id_token;
  if (typeof token !== "string" || token === "") {
    throw new Error(`issuer の応答に token がありません: ${text.slice(0, 200)}`);
  }
  return token;
};

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

const main = async () => {
  const windmillToken = process.env["WINDMILL_TOKEN"];
  if (windmillToken === undefined || windmillToken === "") {
    throw new Error(
      "WINDMILL_TOKEN is not set —— pnpm run windmill:bootstrap の出力を .env に貼ってください",
    );
  }

  const jwt = await mintToken();
  const tokenAction = await upsertVariable(windmillToken, TOKEN_PATH, jwt, true);
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

  process.stderr.write(
    `${TOKEN_PATH} を${tokenAction} (sub=${SUBJECT} orgs=${ORGANIZATIONS.join(",")} exp=${EXPIRES_IN})\n` +
      `${URL_PATH} を${urlAction} (${apiUrl}${apiUrlFrom})\n` +
      `${ENDPOINTS_PATH} を${endpointsAction} (${BROWSERHIVE_ENDPOINTS.join(", ")})\n` +
      `${TLS_CA_PATH} を${tlsAction} (${TLS_CA_PEM === "" ? "空 = 平文" : "CA あり"})\n\n` +
      `付与を忘れずに:  cd ../capture-ledger && pnpm run fga:grant submitter ${SUBJECT} ${ORGANIZATIONS[0] ?? "acme"}\n`,
  );
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
