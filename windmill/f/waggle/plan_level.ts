/**
 * 1 段ぶんの URL をホストで束ね、robots.txt を見て取ってよいものだけを残す。
 *
 * ## なぜホストで束ねるのか
 *
 * これが礼儀の仕組みそのもの。束ねた単位を flow の for-loop が **並列に**回し、
 * 1 つの束の中は `crawl_host` が **逐次**処理する。結果として
 * 「同時に触るホストは N まで、1 ホストには 1 本ずつ」になる。
 *
 * Windmill の per-key concurrency limit に頼らないのは Community Edition で効かないから
 * (`crawl_host.ts` の冒頭に詳しい)。**ループの形で強制する。**
 *
 * ## robots.txt は 1 段につき 1 ホスト 1 回
 *
 * この script は段ごとに 1 回走るので、robots も段ごとに引き直される —— 2 段なら
 * 2 回 (実測で確認)。段の中では何 URL あっても 1 回。
 *
 * 段をまたいで持ち越さないのは、持ち越す先が無いから: 段は別のジョブで、Windmill の
 * 状態は共有されない (`getState` は path と flow に紐づく)。1 段 1 回で受け入れる。
 *
 * `Crawl-delay` があれば、設定した間隔と比べて**長いほうを採る**。相手が言っている値を
 * こちらの都合で縮めない。実測: 設定 1000ms に対して capture-fixtures の `Crawl-delay: 3` が
 * 勝ち、間隔は 3203 / 3014 / 3006ms になった。
 *
 * ## 並列度は BrowserHive のエンドポイントの数で頭を押さえる
 *
 * BrowserHive は browser 1 台にエンドポイント 1 つで、走行中のエンドポイントは `429 Busy` で断る
 * (`crawl_host.ts`)。エンドポイントより多くのホストを同時に回しても、余ったぶんは busy を引いて
 * 待つだけで相手から見た並列度は増えない。だから for-loop に渡す `parallelism` は
 * `min(host_parallelism, エンドポイントの数)` —— 決めるのはここで、flow の式には置かない。
 *
 * ## robots.txt の例外 (t-6bc6)
 *
 * 組織の admin が capture-ledger に登録した行 (ホスト・path の型・範囲・名乗り) に当たる頁は、robots.txt が
 * 断っていても撮る。**判じるのはここ 1 か所。** どの行がこのクロールのこの段に効きうるか (組織・期限・取り消し・
 * 人か機械か・残りの枚数) は capture-ledger が決めて `robots_exemptions` で渡し、ここは robots.txt と path の型で判じる。
 *
 *   - robots.txt は今までどおり読み、`Crawl-delay` も効く。行が外すのは、robots.txt が断った頁だけ ——
 *     断っていない頁には何も付けない
 *   - 行の在るホストは、行の名乗りで撮る (断っていない頁も)。robots.txt を照らす名前も、その名乗りから決める
 *   - 外した頁の在るホストの間隔は 2000ms より詰めない
 *   - 行の形はここでも検査する。通らない行は当てない (今までどおり robots.txt に従う側に倒れる)
 */
import robotsParser from "robots-parser";
import * as wmill from "windmill-client";

/**
 * robots を照らす名前。字に `BrowserHive` があれば、その名前で照らす (robots-parser は名指しの組が先で、無ければ `*`)。
 * 無ければ、相手にその名前を見せていないので `*` の規則を見る (RFC 9309 §2.2.1: 名前は送る User-Agent に含める)。
 * robots.txt を取りに行くときの字は変えない。
 */
export const robotsToken = (userAgent: string | null): string =>
  /\bBrowserHive\b/.test(userAgent ?? "") ? "BrowserHive" : "*";

export interface Candidate {
  url: string;
  host: string;
  /** このホストを最後に触り終えた時刻。capture-ledger が入れる。最初の段は null。 */
  lastFinishedAt?: string | null;
}

/**
 * WACZ に書く申告。capture-ledger が行から組み、`crawl_host` が BrowserHive の `robotsOverride` にそのまま渡す
 * (BrowserHive の `model/main.smithy` の `RobotsOverride`)。**ここは中身を見ず、書き換えない。**
 */
export interface RobotsDeclaration {
  exemptionId: string;
  reason: string;
  pathPattern: string;
  scope: "seeds" | "links";
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
}

/**
 * robots.txt の例外の行。**この段に効きうる行だけを、capture-ledger が選んで渡す** (組織・期限・取り消し・
 * 人か機械か)。ここが見るのは、ホスト・範囲と深さ・path の型・残りの枚数。
 */
export interface RobotsExemption {
  /** 行の番号 (数字の字)。 */
  id: string;
  /** `url.host` の形。候補の `host` と字で比べる。 */
  host: string;
  /** robots.txt と同じ書き方の 1 行 (`*` と末尾の `$`)。 */
  pathPattern: string;
  /** `seeds` は深さ 0 だけ、`links` はどの深さにも効く。 */
  scope: "seeds" | "links";
  /** このホストで名乗る名。 */
  userAgent: string;
  /** この段で、この行で外してよい残りの枚数。 */
  remaining: number;
  declaration: RobotsDeclaration;
}

export interface HostGroup {
  host: string;
  urls: string[];
  /**
   * このホストで名乗る User-Agent。この段で効く例外の行が在れば行の名乗り、無ければクロールの `user_agent` を
   * **そのまま**運ぶ。capture-ledger は `user_agent` を必ず字で送る (指定なしは `""`)。`null` は flow か
   * capture-ledger の取り違えで、ここで `""` に替えると、名乗りを頼んだクロールが browser の字のまま黙って
   * 撮られる —— 替えずに運び、`crawl_host` が投げる (`askedUserAgent`)。
   */
  userAgent: string | null;
  /**
   * robots.txt を例外で外した頁の申告 (URL → 申告)。外した頁が在るときだけ持つ。`crawl_host` が、その頁の
   * 撮る要求にだけ付ける。
   */
  robotsOverrides?: Record<string, RobotsDeclaration>;
  /** このホストに対して実際に使う間隔。robots が長い値を言っていればそれ。 */
  delayMs: number;
  /**
   * **1 件目を投げる前に待つ時間。**
   *
   * 間隔は `crawl_host` の呼び出し 1 回の中でしか効かない。段は呼び出しが分かれるので、
   * これが無いと**段の境目だけ間隔が空かない** —— 実測で 521ms まで詰まった
   * (設定は 3000ms)。前の段の完了からの経過を差し引いた残りを、ここで待つ。
   */
  initialDelayMs: number;
}

export interface Skipped {
  url: string;
  reason: string;
}

/** robots.txt を例外で外して通した頁と、その行の番号。 */
export interface Overridden {
  url: string;
  exemptionId: string;
}

export interface Plan {
  groups: HostGroup[];
  /** 取らなかったものと理由。capture-ledger に報告して `crawl_pages` に残す。 */
  skipped: Skipped[];
  /** robots.txt を例外で外して通した頁。`report_level` が結果に行の番号を付けて報告する。無ければ空。 */
  overridden: Overridden[];
  /** for-loop に渡す同時数。`host_parallelism` を BrowserHive のエンドポイントの数で頭打ちにしたもの。 */
  parallelism: number;
}

/** flow の schema と同じ既定。webhook 起動では schema の既定値が埋まらないのでここにも要る。 */
const DEFAULT_HOST_PARALLELISM = 4;

/**
 * `u/admin/browserhive_endpoints` (文字列の JSON 配列) の要素数。
 *
 * 形の検査は `crawl_host.ts` の `parseEndpoints` と同じ —— エンドポイントが 1 つも無い一覧を
 * 「並列度 0」として通すと、for-loop は何も回さずに段が空で成功する。
 */
export const endpointCount = (raw: string): number => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`browserhive_endpoints が JSON ではありません: ${raw.slice(0, 80)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `browserhive_endpoints は空でない文字列の配列にしてください: ${raw.slice(0, 80)}`,
    );
  }
  return parsed.length;
};

/** 1 以上、エンドポイントの数以下。`null` は「渡されていない」で、flow の schema と同じ既定に落とす。 */
export const parallelismFor = (
  hostParallelism: number | null | undefined,
  endpoints: number,
): number => Math.max(1, Math.min(hostParallelism ?? DEFAULT_HOST_PARALLELISM, endpoints));

/**
 * robots.txt を引く。
 *
 * **読めなければ「制限なし」として扱う。** 404 も接続失敗も同じ ——
 * robots.txt が無いことは、取ってはいけないという意味ではない。
 * ただし取得そのものは 1 ホスト 1 回だけにする。
 */
const fetchRobots = async (host: string, scheme: string) => {
  const url = `${scheme}//${host}/robots.txt`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    return robotsParser(url, await res.text());
  } catch {
    return undefined;
  }
};

// ── robots.txt の例外の行の形 ──
// **capture-ledger の登録の検査 (`src/exemptions/validate.ts` の `pathPatternProblem`・`userAgentProblem`) と同じ決まり。
// 2 度目の検査。** 行は「robots.txt が断っていても撮る」を許す物なので、運ぶ途中で入れ替わった行や、capture-ledger の
// 検査を通らずに入った行を、ここで当てない。決まりを変える時は、capture-ledger の側と字を揃える。
const PATH_PATTERN_MAX = 256;
const USER_AGENT_MAX = 512;
/** 道具の名と、任意の括弧の注 1 つ。注に書けるのは、名乗りを説明する頁の URL (`+https://…` か `+http://…`) だけ。 */
const USER_AGENT_FORM =
  /^BrowserHive\/[0-9A-Za-z.+-]{1,32}(?: \(\+(https?:\/\/[\x21-\x27\x2a-\x7e]+)\))?$/;
/** browser と、よく知られたクローラの印の語。字のどこに在っても断る (大文字小文字を問わない)。 */
const OTHER_AGENT_WORDS = [
  "mozilla",
  "chrome",
  "safari",
  "applewebkit",
  "gecko",
  "firefox",
  "msie",
  "trident",
  "crios",
  "fxios",
  "{chrome}",
  "compatible",
  "google",
  "bingbot",
  "twitterbot",
  "facebookexternalhit",
  "applebot",
  "slurp",
  "duckduckbot",
  "baiduspider",
  "yandex",
  "linkedinbot",
  "slackbot",
  "discordbot",
  "gptbot",
  "claudebot",
];
/** 短くて、ほかの語の一部にもなる印。語の境目で当てる。 */
const OTHER_AGENT_SHORT_WORDS = /\b(?:edg|edge|edga|edgios|opr|opera)\b/i;
/** URL の中の、製品の印の形 (`<語>/<数字>`)。 */
const PRODUCT_TOKEN_IN_URL = /[A-Za-z]\/\d/;

/** path の型のどこが駄目か。良ければ undefined。 */
const pathPatternProblem = (pattern: string): string | undefined => {
  if (!pattern.startsWith("/")) return "pathPattern が / で始まらない";
  if (pattern.length > PATH_PATTERN_MAX) {
    return `pathPattern が ${String(PATH_PATTERN_MAX)} 字を超える`;
  }
  // 印字できる ASCII (0x21–0x7e) だけ。改行や `#` を許すと、型を 1 行の規則として読むときに別の規則・注になる
  if (!/^[\x21-\x7e]+$/.test(pattern) || pattern.includes("#")) {
    return "pathPattern が、空白と # の無い印字できる ASCII の 1 行ではない";
  }
  return undefined;
};

/** 名乗る User-Agent のどこが駄目か。良ければ undefined。 */
const userAgentProblem = (userAgent: string): string | undefined => {
  if (userAgent.length > USER_AGENT_MAX) {
    return `userAgent が ${String(USER_AGENT_MAX)} 字を超える`;
  }
  const lower = userAgent.toLowerCase();
  if (
    OTHER_AGENT_WORDS.some((word) => lower.includes(word)) ||
    OTHER_AGENT_SHORT_WORDS.test(userAgent)
  ) {
    return "userAgent に browser かほかのクローラの名が在る";
  }
  const form = "userAgent が BrowserHive/<版> (と、任意の (+https://…)) の形ではない";
  const url = USER_AGENT_FORM.exec(userAgent)?.[1];
  if (!USER_AGENT_FORM.test(userAgent)) return form;
  if (url !== undefined && !URL.canParse(url)) return form;
  if (url !== undefined && PRODUCT_TOKEN_IN_URL.test(url)) {
    return "userAgent の URL に <字>/<数字> (製品の印の形) が在る";
  }
  return undefined;
};

/**
 * 行のどこが駄目か。良ければ undefined。**export は試験のため。**
 *
 * 届くのは JSON なので、型は当てにしない (欄の型から見る)。
 */
export const exemptionProblem = (row: unknown): string | undefined => {
  if (typeof row !== "object" || row === null) return "行が object ではない";
  const { id, host, pathPattern, scope, userAgent, remaining, declaration } = row as Record<
    string,
    unknown
  >;
  // 番号は数として比べる (当たる行がいくつも在るときの順)
  if (typeof id !== "string" || !/^[0-9]+$/.test(id)) return "id が数字の字ではない";
  if (typeof host !== "string" || host === "") return "host が字ではない";
  if (scope !== "seeds" && scope !== "links") return "scope が seeds でも links でもない";
  if (typeof pathPattern !== "string") return "pathPattern が字ではない";
  const pathProblem = pathPatternProblem(pathPattern);
  if (pathProblem !== undefined) return pathProblem;
  if (typeof userAgent !== "string" || userAgent === "") return "userAgent が無い";
  const agentProblem = userAgentProblem(userAgent);
  if (agentProblem !== undefined) return agentProblem;
  if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0) {
    return "remaining が 0 以上の整数ではない";
  }
  if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
    return "declaration が object ではない";
  }
  return undefined;
};

/** 外した頁の在るホストの間隔の下限。クロールの頼みで間隔を 0 にできても、例外で外すホストでは詰めない。 */
const EXEMPTION_MIN_DELAY_MS = 2000;

/** 検査を通った行と、この段での残りの枚数 (外すたびに減らす。渡された行は書き換えない)。 */
interface UsableExemption {
  row: RobotsExemption;
  left: number;
}

/** 形の検査を通った行だけにする。通らない行は当てず、行の番号と訳を log に出す。 */
const usableExemptions = (rows: unknown): UsableExemption[] => {
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows)) {
    console.log("robots_exemptions が並びではないので、例外なしで進める");
    return [];
  }
  const usable: UsableExemption[] = [];
  for (const row of rows as unknown[]) {
    const problem = exemptionProblem(row);
    if (problem === undefined) {
      const checked = row as RobotsExemption;
      usable.push({ row: checked, left: checked.remaining });
      continue;
    }
    const id = (row as { id?: unknown } | null)?.id;
    console.log(
      `robots.txt の例外の行 ${typeof id === "string" ? id : "(番号なし)"} を当てない: ${problem}`,
    );
  }
  return usable;
};

/**
 * このホストにこの段で効く行。ホストが同じで、範囲が `links` か、深さ 0 の行。
 *
 * **名乗りが 2 種類以上なら、そのホストの行はみな当てない。** capture-ledger は同じ組織・ホストの名乗りを 1 つに
 * 揃えているので、割れていれば壊れた入力 —— どちらかを選ばず、今までどおり robots.txt に従う。
 */
const exemptionsFor = (
  usable: UsableExemption[],
  host: string,
  depth: number | null,
): UsableExemption[] => {
  const effective = usable.filter(
    ({ row }) => row.host === host && (row.scope === "links" || depth === 0),
  );
  const agents = new Set(effective.map(({ row }) => row.userAgent));
  if (agents.size > 1) {
    console.log(
      `[${host}] robots.txt の例外の行の名乗りが ${String(agents.size)} 種類あるので、このホストの行は当てない: ` +
        effective.map(({ row }) => row.id).join(", "),
    );
    return [];
  }
  // 当たる行がいくつも在れば、型の長い行、次に番号の若い行
  return effective.sort(
    (a, b) =>
      b.row.pathPattern.length - a.row.pathPattern.length ||
      (BigInt(a.row.id) < BigInt(b.row.id) ? -1 : 1),
  );
};

export async function main(
  candidates: Candidate[],
  per_host_delay_ms: number,
  respect_robots: boolean | null = true,
  host_parallelism: number | null = null,
  user_agent: string | null = null,
  /** この段の深さ (起点が 0)。範囲が `seeds` の行は、深さ 0 でだけ効く。 */
  depth: number | null = null,
  /**
   * robots.txt の例外の行。capture-ledger が、この段に効きうる行だけを渡す。**`null`・`undefined`・空は「例外なし」** ——
   * Windmill は渡されない引数を `null` で渡すので、行を送らない古い capture-ledger でも今までどおり動く。
   */
  robots_exemptions: RobotsExemption[] | null = null,
): Promise<Plan> {
  const usable = usableExemptions(robots_exemptions);
  // **`null` を「未設定」として扱う。既定引数では足りない。**
  //
  // flow の input_transform は `flow_input.respect_robots` を評価し、渡されていなければ
  // JavaScript の `undefined` になる —— が、Windmill はそれを JSON の **`null`** として
  // 渡してくる。TypeScript の既定引数が効くのは `undefined` のときだけなので、`null` は
  // そのまま素通りし、falsy なので robots が一度も読まれない。
  //
  // 実測で踏んだ: `Disallow: /links/hidden` のページが取り込まれ、**クロールは成功し、
  // アーカイブも正常に見えた**。capture-fixtures の fixture が無ければ気づけなかった。
  const respectRobots = respect_robots ?? true;

  const byHost = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byHost.get(c.host);
    if (list) list.push(c);
    else byHost.set(c.host, [c]);
  }

  const groups: HostGroup[] = [];
  const skipped: Skipped[] = [];
  const overridden: Overridden[] = [];

  for (const [host, list] of byHost) {
    const first = list[0];
    if (first === undefined) continue;
    // scheme は最初の URL から取る。同じホストで混在していれば、そちらは別の
    // origin なので既に範囲の絞り込みで落ちている (capture-ledger 側の `inScope`)。
    const scheme = new URL(first.url).protocol;
    const robots = respectRobots ? await fetchRobots(host, scheme) : undefined;

    // **名乗りはホストごとに決める。** この段で効く行が在れば、そのホストの頁はみな (robots.txt が断っていない頁も)
    // 行の名乗りで撮り、robots.txt もその名乗りで照らす —— 相手に見せる名前と、規則を読む名前を揃える。
    const exemptions = exemptionsFor(usable, host, depth);
    const userAgent = exemptions[0]?.row.userAgent ?? user_agent;
    const token = robotsToken(userAgent);
    // 型は、robots-parser に 1 行の規則として読ませる (型の読み方が robots.txt と揃う)。base は robots.txt と同じ
    // origin にする —— origin の違う URL を、robots-parser は判じない。
    const patterns = exemptions.map((exemption) => ({
      exemption,
      rule: robotsParser(
        `${scheme}//${host}/robots.txt`,
        `User-agent: *\nDisallow: ${exemption.row.pathPattern}`,
      ),
    }));

    const allowed: string[] = [];
    const robotsOverrides: Record<string, RobotsDeclaration> = {};
    for (const c of list) {
      // **robots.txt が断っていない頁には何も付けない。** 行が外すのは、断られた頁だけ。
      if (robots === undefined || robots.isDisallowed(c.url, token) !== true) {
        allowed.push(c.url);
        continue;
      }
      const matching = patterns
        .filter(({ rule }) => rule.isDisallowed(c.url, "*") === true)
        .map(({ exemption }) => exemption);
      if (matching.length === 0) {
        skipped.push({ url: c.url, reason: "robots" });
        continue;
      }
      // 型に当たる行のうち、残りの在る最初の行で外す。どの行も残りが尽きていれば見送る
      const exemption = matching.find(({ left }) => left > 0);
      if (exemption === undefined) {
        skipped.push({ url: c.url, reason: "robots-exemption-limit" });
        continue;
      }
      exemption.left -= 1;
      overridden.push({ url: c.url, exemptionId: exemption.row.id });
      robotsOverrides[c.url] = exemption.row.declaration;
      allowed.push(c.url);
    }

    if (allowed.length === 0) continue;
    const overrode = Object.keys(robotsOverrides).length > 0;

    // #region delay
    // **長いほうを採る。** 相手が言っている値をこちらの都合で縮めない。
    const crawlDelaySec = robots?.getCrawlDelay(token);
    const politeDelayMs =
      typeof crawlDelaySec === "number" && Number.isFinite(crawlDelaySec)
        ? Math.max(per_host_delay_ms, Math.round(crawlDelaySec * 1000))
        : per_host_delay_ms;
    // robots.txt を例外で外した頁の在るホストは、2000ms より詰めない (クロールの頼みで間隔を 0 にできても)。
    const delayMs = overrode ? Math.max(politeDelayMs, EXEMPTION_MIN_DELAY_MS) : politeDelayMs;

    // 前の段でこのホストを触り終えてからの経過を差し引く。
    const lastFinished = list
      .map((c) => c.lastFinishedAt)
      .find((t) => t !== null && t !== undefined);
    const sinceMs =
      lastFinished === undefined || lastFinished === null
        ? Number.POSITIVE_INFINITY
        : Date.now() - new Date(lastFinished).getTime();
    const initialDelayMs = Number.isFinite(sinceMs) ? Math.max(0, delayMs - sinceMs) : 0;
    // #endregion delay

    groups.push({
      host,
      urls: allowed,
      delayMs,
      initialDelayMs,
      userAgent,
      ...(overrode ? { robotsOverrides } : {}),
    });
  }

  const endpoints = endpointCount(await wmill.getVariable("u/admin/browserhive_endpoints"));
  const parallelism = parallelismFor(host_parallelism, endpoints);

  const total = groups.reduce((n, g) => n + g.urls.length, 0);
  // **robots を読んだかどうかを必ず出す。** 「見送り 0 件」は「規則が無い」と
  // 「規則を読んでいない」の両方に見えるので、区別が付くようにしておく。
  console.log(
    `${String(groups.length)} ホスト / ${String(total)} URL` +
      ` (robots: ${respectRobots ? "尊重" : "無視"}` +
      (skipped.length > 0 ? `、${String(skipped.length)} 件を見送り` : "") +
      (overridden.length > 0 ? `、${String(overridden.length)} 件を例外で外した` : "") +
      `、同時 ${String(parallelism)} ホスト / エンドポイント ${String(endpoints)})`,
  );

  return { groups, skipped, overridden, parallelism };
}
