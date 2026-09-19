/**
 * e2e の前に、要るものが待ち受けているかを確かめる。
 *
 * **vitest の中ではなくここに置く。** globalSetup が throw すると vitest は必ず
 * 「No test files found, exiting with code 1」を先に出す (browserhive で実測して
 * ある)。メッセージがどれだけ良くても、読む人はまずファイルのフィルタを疑う。
 * その 1 行を直せるのは vitest の外だけなので、`pretest:e2e` から呼ぶ。
 *
 * **足りなければ全部まとめて名指しする。** 1 件目で諦めると、1 回の間違いで
 * 2 往復させることになる。
 *
 * 待たない。profile を間違えて立てたものは待っても来ない。
 *
 * ## 立っているか、だけでなく、つながっているか
 *
 * 後ろの 3 つは「クロールが最後まで走る設定か」を見る。どれも外れていると、API に
 * POST すれば 202 が返り、Windmill の flow も走り、**段の報告のところで初めて落ちる** ——
 * 報告が届かなければクロールは `running` のまま残り、以後の起動は全部 409 になる。
 * docs に書いた手順が 2 か所で古くなっていたのを見つけて足した (webhook の 2 行、宛先の IP)。
 *
 *   crawl route    `/api/crawls` が在るか (webhook の 2 行が無いと route ごと無い)
 *   jwt            API が JWT を受けるか (flow の報告は Bearer だけを持ってくる)
 *   container→api  Windmill の変数の宛先に、コンテナから届くか (0.0.0.0 と IP)
 *
 * **どれも、正しい設定と誤った設定で答えが変わる入力を使う。** たとえば jwt を
 * 「ヘッダで名乗ると 401」で見ると、名乗りの口がどちらも無い API も 401 で通ってしまう。
 * だから issuer から token を取り、それが 200 になることを見る。
 *
 * `--connection` を付けると、つながりだけを見る (capture-fixtures を見ない)。
 * `pnpm run check:connection` がそれで、docs の手順の最後に叩く。
 */
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";

import { optional, windmillFetch, windmillWorkspace } from "./env.js";

/** HTTP の答えが返ること自体が待ち受けの証拠。405 でも 401 でもよい。 */
const answers = (url: string): Promise<boolean> =>
  fetch(url, { signal: AbortSignal.timeout(3000) }).then(
    () => true,
    () => false,
  );

const portOpen = (host: string, port: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3000);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });

/** 応答の status。届かなければ undefined。 */
const statusOf = async (url: string, init: RequestInit = {}): Promise<number | undefined> => {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
    await res.text();
    return res.status;
  } catch {
    return undefined;
  }
};

const API = "http://127.0.0.1:7070";
const ISSUER = optional("CAPTURE_LEDGER_OIDC_ISSUER", "http://127.0.0.1:9099");
/** 段の報告を送るのは worker。宛先に届くかは、そのコンテナの中から見る。 */
const WORKER = "windmill-worker.capture-scheduler";

/**
 * issuer から token を取り、Bearer で一覧を読む。**200 になるのは JWT を受ける API だけ** ——
 * ヘッダの設定の API も、どちらの口も無い API も 401 を返す。
 */
const acceptsJwt = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${ISSUER}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "check-stack", organizations: ["acme"], expiresIn: "5m" }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string") return false;
    const status = await statusOf(`${API}/api/archives`, {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    return status === 200;
  } catch {
    return false;
  }
};

/**
 * flow が段の報告を送る宛先 (変数 `u/admin/waggle_api_url`) に、worker の中から届くか。
 *
 * 変数を読むのは、**flow が実際に使うのはそちら**だから —— いま gateway を計算し直しても、
 * 変数に古い IP が入っていれば報告は届かない。変数は `windmill:capture-ledger-token` が入れる。
 */
const reachableFromContainer = async (): Promise<boolean> => {
  const token = process.env["WINDMILL_TOKEN"];
  if (token === undefined || token === "") return false;
  try {
    const url = await windmillFetch(
      `/api/w/${windmillWorkspace()}/variables/get_value/u/admin/waggle_api_url`,
      { token },
    );
    if (typeof url !== "string") return false;
    // **同期で呼ばないこと。** 点検は並べて走らせるので、execFileSync で待つと
    // 届かない宛先の 5 秒のあいだ event loop が止まり、隣の jwt の 3 秒の期限が
    // 先に切れて、jwt まで ✗ になった (実測)。
    const { stdout: code } = await promisify(execFile)(
      "container",
      [
        "exec",
        WORKER,
        "curl",
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "5",
        `${url}/healthz`,
      ],
      { encoding: "utf8" },
    );
    return code.trim() === "200";
  } catch {
    return false;
  }
};

const CHECKS = [
  {
    name: "windmill",
    where: "127.0.0.1:8000",
    need: "capture-scheduler: container-compose up -d -b",
    probe: () => answers("http://127.0.0.1:8000/api/version"),
  },
  {
    name: "capture-ledger api",
    where: "127.0.0.1:7070",
    need: "capture-ledger: pnpm run api",
    probe: () => answers("http://127.0.0.1:7070/healthz"),
  },
  {
    name: "oidc issuer",
    where: "127.0.0.1:9099",
    need: "capture-ledger: pnpm run oidc:issuer （トークンの発行元。再起動すると鍵が変わる）",
    probe: () => answers("http://127.0.0.1:9099/.well-known/openid-configuration"),
  },
  {
    name: "capture-fixtures",
    where: "capture-fixtures.capture-ledger:8080",
    need: "capture-ledger: container-compose --profile capture-fixtures up -d -b",
    probe: () => portOpen("capture-fixtures.capture-ledger", 8080),
    e2eOnly: true,
  },
  {
    name: "crawl route",
    where: "POST 127.0.0.1:7070/api/crawls {} (名乗らずに 401 なら在る)",
    need:
      "capture-ledger の .env に CAPTURE_LEDGER_CRAWL_WEBHOOK_URL と _TOKEN" +
      " (windmill:bootstrap が出す 2 行) を書いて API を起こし直す。無いと /api/crawls ごと無い (404)",
    // 本文を付けること。付けないと、名乗りを見る前に body の検査が 400 を返す (実測)。
    probe: async () =>
      (await statusOf(`${API}/api/crawls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })) === 401,
  },
  {
    name: "jwt",
    where: "issuer の token で GET 127.0.0.1:7070/api/archives",
    need:
      "capture-ledger の .env に CAPTURE_LEDGER_OIDC_ISSUER=http://127.0.0.1:9099 を書いて API を" +
      "起こし直す。ヘッダの設定の API では、flow の段の報告 (Bearer) が 401 になる",
    probe: acceptsJwt,
  },
  {
    name: "container→api",
    where: "u/admin/waggle_api_url の /healthz を worker の中から",
    need:
      "capture-ledger を CAPTURE_LEDGER_API_HOST=0.0.0.0 で起こす (127.0.0.1 はコンテナから届かない)。" +
      "宛先の IP が古ければ pnpm run windmill:capture-ledger-token をやり直す。" +
      "変数を読むので .env の WINDMILL_TOKEN も要る",
    probe: reachableFromContainer,
  },
];

const connectionOnly = process.argv.includes("--connection");
const selected = CHECKS.filter((check) => !(connectionOnly && "e2eOnly" in check));

const results = await Promise.all(
  selected.map(async (check) => ({ ...check, ok: await check.probe() })),
);

for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(18)} ${r.where}`);
}

const missing = results.filter((r) => !r.ok);
if (missing.length > 0) {
  console.error(connectionOnly ? "\nつながっていません:" : "\ne2e にはこれらが要ります:");
  for (const r of missing) console.error(`  ${r.name} —— ${r.need}`);
  process.exit(1);
}
