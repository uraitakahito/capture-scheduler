/**
 * Windmill の中身の読み分け —— workspace・push・変数・目録。
 *
 * どれも「在るか」だけでなく「repo と同じか」を見る。push を忘れたことは、flow が走って
 * 古い script が動くまで何も言わない。
 *
 * 入出力を持たない。答えを取ってくるのは `checks.ts`。
 */
import type { Verdict } from "./run.js";

/** HTTP の答え。届かなければ status は undefined。 */
export interface Answer {
  status: number | undefined;
  body: string;
}

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

const shown = ({ status, body }: Answer): string =>
  `${String(status)} ${body.trim().slice(0, 200)}`;

/** bootstrap をやり直したとき、貼り直す先は 2 つある (この repo と capture-ledger)。 */
const REBOOTSTRAP =
  "pnpm run windmill:bootstrap をやり直し、出た WINDMILL_TOKEN=… をこの repo の .env に、" +
  "webhook の 2 行を capture-ledger の .env に貼り直す (API も起こし直す)";

/**
 * `users/whoami` の答え。**200 だけでは足りない** —— super admin の token は、無い workspace
 * に訊いても 200 で `non_member: true` を返す (実測)。そのときだけ workspace が在るかを訊く。
 */
export const readWorkspace = ({
  workspace,
  whoami,
  exists,
}: {
  workspace: string;
  whoami: Answer;
  /** `POST /api/workspaces/exists` の答え。`non_member` のときだけ訊く。 */
  exists?: boolean;
}): Verdict => {
  if (whoami.status === 401) {
    return {
      ok: false,
      need: `Windmill が WINDMILL_TOKEN を受けない (Windmill の DB を作り直すと token も消える) → ${REBOOTSTRAP}`,
    };
  }
  const me = whoami.status === 200 ? parse(whoami.body) : undefined;
  if (typeof me !== "object" || me === null || !("non_member" in me)) {
    return { ok: false, need: `users/whoami → ${shown(whoami)}` };
  }
  if (me.non_member !== true) return { ok: true };
  if (exists === false) {
    return { ok: false, need: `workspace ${workspace} が無い → pnpm run windmill:bootstrap` };
  }
  const email = "email" in me && typeof me.email === "string" ? me.email : "token の持ち主";
  return {
    ok: false,
    need: `${email} は workspace ${workspace} の member でない → ${REBOOTSTRAP}`,
  };
};

/** repo の 1 本と、Windmill に入っているもの。 */
export interface Deployed {
  path: string;
  kind: "script" | "flow" | "schedule";
  /** 在るか。script は中身が要るので `content` で見る。 */
  exists: boolean;
  /** script だけ。repo の中身と、Windmill の中身 (無ければ undefined)。 */
  content?: { repo: string; windmill: string | undefined };
}

/**
 * push が済んでいるか。script は中身まで比べ、flow と schedule は在るかだけを見る ——
 * flow.yaml は script を `!inline` で抱えるので、比べるなら wmill の解決をなぞることになる。
 * flow の差は `windmill:diff` に任せる。
 */
export const readPush = (items: readonly Deployed[]): Verdict => {
  const missing = items.filter((item) => !item.exists).map((item) => `${item.path} (${item.kind})`);
  const differs = items
    .filter((item) => item.exists && item.content !== undefined)
    .filter((item) => item.content?.repo !== item.content?.windmill)
    .map((item) => item.path);
  if (missing.length === 0 && differs.length === 0) return { ok: true };
  const parts = [
    ...(missing.length > 0 ? [`Windmill に無い: ${missing.join("・")}`] : []),
    ...(differs.length > 0 ? [`repo と中身が違う: ${differs.join("・")}`] : []),
  ];
  return {
    ok: false,
    need: `${parts.join("。")} → pnpm run windmill:push (違いを見るだけなら windmill:diff)`,
  };
};

/** flow と点検が読む変数。`windmill:capture-ledger-token` が 5 つとも入れる。 */
export const VARIABLES = [
  "u/admin/waggle_token",
  "u/admin/waggle_api_url",
  "u/admin/browserhive_endpoints",
  "u/admin/browserhive_tls_ca",
  "u/admin/ts_compile_url",
] as const;

/**
 * `GET /api/scripts` の答え。**目録が空なら ✗。**
 *
 * 空でもクロールは起こせてしまう時期が在った —— ページの中で何も走らず、スクロールも
 * 遅延読み込みも起きないまま `complete: true` のアーカイブが出る。capture-ledger は
 * いまそれを 400 で止めるが、**止まるのは頼んだ後**。doctor は「全部 ✓ なら、クロールを
 * 起こせば最後まで走る」と名乗っているので、頼む前にここで言う。
 *
 * 404 は「許可が無い」—— 口そのものは webhook の設定に依らず出るので、
 * 在るかどうかではなく can_submit を疑う先になる。
 */
export const readCatalog = (answer: Answer): Verdict => {
  if (answer.status === 404) {
    return { ok: false, need: "この token にクロールの許可が無い (上の can_submit を先に)" };
  }
  const value = answer.status === 200 ? parse(answer.body) : undefined;
  const scripts =
    typeof value === "object" && value !== null && "scripts" in value ? value.scripts : undefined;
  if (!Array.isArray(scripts)) {
    return { ok: false, need: `GET /api/scripts → ${shown(answer)}` };
  }
  if (scripts.length > 0) return { ok: true };
  return {
    ok: false,
    need:
      "目録が空 —— 撮れてもページの中では何も走らない (クロールは 400 で断られる) → " +
      "cd ../capture-ledger && pnpm run scripts import .upstream/capture-scripts",
  };
};

export const readVariables = (exists: ReadonlyMap<string, boolean>): Verdict => {
  const missing = VARIABLES.filter((path) => exists.get(path) !== true);
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    need: `変数が無い: ${missing.join("・")} → pnpm run windmill:capture-ledger-token`,
  };
};
