/**
 * 環境変数の読み口。capture-ledger の `src/config/env.ts` と同じ規約に揃えてある。
 *
 * どちらの getter も空文字を「無い」と同じに扱う。POSIX の `${VAR:-word}` 側の
 * 意味で、`??` (`${VAR-word}` 側) は使わない —— `.env` の `NAME=` は既定値を
 * 潰したうえで、名前が一言も出ないエラーになるため。
 */
import { execFileSync } from "node:child_process";

/**
 * この repo が読む環境変数の全体。**`guardEnv` の検査対象そのもの** なので、
 * 変数を足したらここにも足すこと。`.env.example` との突き合わせは
 * `scripts/check-env.ts` が行う。
 */
export const OPTIONAL_ENV = [
  "WINDMILL_URL",
  "WINDMILL_WORKSPACE",
  "WINDMILL_EMAIL",
  "WINDMILL_PASSWORD",
  "CAPTURE_LEDGER_API_URL",
  "CAPTURE_LEDGER_OIDC_ISSUER",
  "CAPTURE_LEDGER_SUBJECT",
  "CAPTURE_LEDGER_ORGANIZATIONS",
  "CAPTURE_LEDGER_TOKEN_EXPIRES_IN",
  "CAPTURE_LEDGER_BROWSERHIVE_ENDPOINTS",
  "CAPTURE_LEDGER_BROWSERHIVE_TLS_CA_PEM",
];

/** 値を貼るまで空でいる変数。`guardEnv` の対象外。 */
export const PASTED_ENV = ["WINDMILL_TOKEN"];

/**
 * 空で設定されている optional な変数があれば、起動時に落とす。
 *
 * 空文字は無害ではない。既定値を通り抜けて、その変数名がどこにも出ない形で
 * ずっと先で失敗する。行ごと消せば即座に名指しで落ちる。
 */
export const guardEnv = () => {
  const blank = OPTIONAL_ENV.filter((name) => process.env[name] === "");
  if (blank.length === 0) return;
  process.stderr.write(
    `空で設定されている環境変数:\n${blank.map((n) => `  - ${n}`).join("\n")}\n\n` +
      "  値を書くか、行ごと消すこと。空文字は既定値を潰します。\n",
  );
  process.exit(1);
};

export const optional = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};

export const required = (name: string, hint?: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set${hint === undefined ? "" : ` (${hint})`}`);
  }
  return value;
};

/**
 * repo の根。**dist 経由で動くことを前提に解く。**
 *
 * script は `dist/scripts/foo.js` として実行されるので、自分の位置から
 * `..` を 1 つ登ると `dist/` で止まる —— `.env.example` も `proto/` も
 * `docs-site/` もそこには無い。TypeScript 化のときに実際に踏んだ
 * (`ENOENT: dist/.env.example`)。
 *
 * `process.cwd()` を使うのは、**package.json の script から呼ばれる**ため。
 * pnpm は repo の根で実行するので、どこから叩いても根が返る。`import.meta.url`
 * に頼ると「ソースの位置」と「実行される位置」が別物になった瞬間に壊れる。
 */
export const repoRoot = (): string => process.cwd();

/** よく使う 2 つ。既定値は `.env.example` のコメントと一致させること。 */
export const windmillUrl = () => optional("WINDMILL_URL", "http://127.0.0.1:8000");
export const windmillWorkspace = () => optional("WINDMILL_WORKSPACE", "crawler");

/**
 * クロール 1 段を回す flow のパス。**webhook の URL の一部**で、実体は
 * `windmill/f/waggle/crawl_level.flow/`。
 *
 * capture-ledger に貼る URL はここから組み立てる (`ledgerEnv`)。人に組み立てさせて
 * いた頃、capture-ledger の `.env.example` の例は `…/f/waggle/crawl` と古くなっていて、
 * そのとおりに設定するとクロールが failed になり `flow not found` の 404 が出た。
 * flow の名前を変えると、`test/env.test.ts` が実体の無いパスとして落とす。
 */
export const CRAWL_FLOW_PATH = "f/waggle/crawl_level";

/**
 * capture-ledger の dev issuer。**トークンを取りに行く先 (`windmill:capture-ledger-token`・doctor) と、
 * capture-ledger が照合する先 (`ledgerEnv` の 4 行目) は、同じ値でなければならない** ——
 * 一字一句違うだけで、flow の JWT は 401 になる。だから 1 か所で決める。
 */
export const ledgerIssuer = (): string =>
  optional("CAPTURE_LEDGER_OIDC_ISSUER", "http://127.0.0.1:9099");

/**
 * capture-ledger の `.env` の**末尾に**貼る 4 行。**`windmill:bootstrap` が出力し、クイックスタートが
 * 同じ形で載せる** (一致は `check-doc-refs.ts` が見る)。
 *
 * 以前は webhook の 2 行だけを出していた。残りの 2 行 (待ち受けと issuer) はクイックスタートと
 * capture-ledger の `.env.example` に `#` 付きで在るだけで、2026-09-19 と 20 の 2 回とも、止まったのは
 * その 2 行だった —— 貼ったのは道具が出した 2 行だけ。4 行とも出せば、貼るものは 1 か所になる。
 *
 * 末尾に貼らせるのは、node の `--env-file` では同じ名前の後ろの行が効くから。`.env.example` を写した
 * `.env` には `#CAPTURE_LEDGER_API_HOST=127.0.0.1` のような行が前に在るが、末尾の行が勝つ。
 *
 * token は bootstrap が作った API token そのもの —— capture-ledger はそれで webhook を叩く。
 */
export const ledgerEnv = ({
  windmillUrl: base,
  workspace,
  token,
  issuer,
}: {
  windmillUrl: string;
  workspace: string;
  token: string;
  issuer: string;
}): string[] => [
  `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=${base}/api/w/${workspace}/jobs/run/f/${CRAWL_FLOW_PATH}`,
  `CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=${token}`,
  // 段の報告はコンテナ (Windmill の worker) から来る。127.0.0.1 で待つ API には届かない。
  "CAPTURE_LEDGER_API_HOST=0.0.0.0",
  // flow は JWT で名乗る。これが無い API は開発用ヘッダで名乗る設定になり、段の報告は 401。
  `CAPTURE_LEDGER_OIDC_ISSUER=${issuer}`,
];

/**
 * `container network inspect default` の出力から、default ネットワークの gateway を取り出す。
 *
 * **読めなければ投げる。** 以前の決め打ち (`192.168.64.1`) のような既定値へは黙って
 * 落とさない —— 外れた宛先は、ずっと後の「段の報告が ConnectionRefused」でしか分からない。
 */
export const parseGateway = (json: string): string => {
  let gateway: unknown;
  try {
    const parsed = JSON.parse(json) as { status?: { ipv4Gateway?: unknown } }[];
    gateway = parsed[0]?.status?.ipv4Gateway;
  } catch {
    // 読めない出力も、下で同じように名指しして投げる。
  }
  if (typeof gateway !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway)) {
    throw new Error(
      "default ネットワークの gateway を読めません (container network inspect default の " +
        "status.ipv4Gateway)。CAPTURE_LEDGER_API_URL を .env に書いてください",
    );
  }
  return gateway;
};

/** 既定の問い合わせ。試験は `ledgerApiUrl` の引数で差し替える。 */
const inspectDefaultNetwork = (): string =>
  execFileSync("container", ["network", "inspect", "default"], { encoding: "utf8" });

/**
 * **コンテナから見た** capture-ledger API の URL。Windmill の変数 `u/admin/waggle_api_url` に
 * 入り、flow の段の報告がここへ届く。
 *
 * 書いていなければ default ネットワークの gateway から組む。以前は `192.168.64.1` を
 * 決め打ちしていたが、gateway は network を作り直すと変わる (2026-09-19 のこの Mac は
 * `192.168.66.1` で、`.64` は別の network が使っていた)。外れると報告が届かず、クロールは
 * `running` のまま残って、以後の起動を全部 409 で塞ぐ。
 */
export const ledgerApiUrl = (inspect: () => string = inspectDefaultNetwork): string => {
  const explicit = optional("CAPTURE_LEDGER_API_URL", "");
  if (explicit !== "") return explicit;
  let json: string;
  try {
    json = inspect();
  } catch (err) {
    throw new Error(
      `container network inspect default が失敗しました (${err instanceof Error ? err.message : String(err)})。` +
        "CAPTURE_LEDGER_API_URL を .env に書いてください",
    );
  }
  return `http://${parseGateway(json)}:7070`;
};

/**
 * Windmill の API を叩く。
 *
 * 失敗の本文をそのまま投げる —— Windmill は理由を本文で返すので、status だけに
 * すると「400 でした」しか分からなくなる。
 */
export interface WindmillFetchOptions {
  /** 付けると Authorization: Bearer に載る。bootstrap の前は無い。 */
  token?: string;
  method?: string;
  /** JSON にして送る。undefined なら content-type も付けない。 */
  body?: unknown;
}

/**
 * 戻り値が `unknown` なのは、**endpoint ごとに形が違うから**。呼ぶ側が
 * 自分の期待する形に絞る (型アサーションか、必要なら検証) —— ここで
 * `any` を返すと、絞り忘れが型検査を素通りする。
 */
export const windmillFetch = async (
  path: string,
  { token, method = "GET", body }: WindmillFetchOptions = {},
): Promise<unknown> => {
  const res = await fetch(`${windmillUrl()}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${String(res.status)} ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // token の発行など、素の文字列を返す endpoint がある。
    return text;
  }
};
