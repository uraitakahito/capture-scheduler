/**
 * capture-ledger の `GET /api/me` の答えを、`check:connection` の 1 行に読む。
 *
 * 訊くのは **flow が使うのと同じトークン** (Windmill の変数 `u/admin/waggle_token`)。
 * capture-ledger は、そのトークンから解いた名前と組織をそのまま返すので、足りない許可を
 * 打つべきコマンドの形で名指しできる —— `.env` で名前を変えていても、docs に書いた
 * `windmill acme` ではなく、capture-ledger が実際に見た名前を出す。
 *
 * 読み分けるのは status と本文。直すものがそれぞれ違う:
 *
 *   200 canSubmit: true     ✓
 *   200 canSubmit: false    その名前に、その組織のクロールの許可が無い → fga:grant
 *   200 組織が空            トークンに組織が載っていない → CAPTURE_LEDGER_ORGANIZATIONS
 *   401                     トークンが通らない (issuer を起こし直した・API がヘッダの設定)
 *   404 Route GET:/api/me   capture-ledger が古い (`GET /api/me` は v0.42.0 から)
 *   届かない・それ以外       そのまま出す
 *
 * 別の module にしてあるのは、`check-stack.ts` が import した時点で点検を走らせるから ——
 * 読み分けだけを単体で試せるように、ここは入出力を持たない。
 */
export type Verdict = { ok: true } | { ok: false; need: string };

/** Fastify が route の無いときに返す本文。capture-ledger の 404 (`{"error":"not found"}`) と分ける。 */
const ROUTE_MISSING = /Route GET:\/api\/me not found/;

interface Me {
  subject: string;
  organizations: string[];
  canSubmit: boolean;
}

const isMe = (value: unknown): value is Me => {
  if (typeof value !== "object" || value === null) return false;
  const { subject, organizations, canSubmit } = value as Record<string, unknown>;
  return (
    typeof subject === "string" &&
    Array.isArray(organizations) &&
    organizations.every((org) => typeof org === "string") &&
    typeof canSubmit === "boolean"
  );
};

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

export const readCanSubmit = (status: number | undefined, body: string): Verdict => {
  if (status === undefined) {
    return { ok: false, need: "capture-ledger の API に届かない (上の capture-ledger api を先に)" };
  }
  if (status === 401) {
    return {
      ok: false,
      need:
        "Windmill のトークンが通らない —— issuer を起こし直したか、API が JWT を受けていない" +
        " (上の jwt)。pnpm run windmill:capture-ledger-token をやり直す",
    };
  }
  if (status === 404 && ROUTE_MISSING.test(body)) {
    return {
      ok: false,
      need: "capture-ledger が古い (GET /api/me は v0.42.0 から)。更新して API を起こし直す",
    };
  }
  const me = status === 200 ? parse(body) : undefined;
  if (!isMe(me)) {
    return { ok: false, need: `GET /api/me → ${String(status)} ${body.slice(0, 200)}` };
  }
  if (me.canSubmit) return { ok: true };
  const [org] = me.organizations;
  if (org === undefined) {
    return {
      ok: false,
      need:
        `トークンの ${me.subject} に組織が載っていない —— CAPTURE_LEDGER_ORGANIZATIONS を見て、` +
        "pnpm run windmill:capture-ledger-token をやり直す",
    };
  }
  return {
    ok: false,
    need:
      `${me.subject} に ${org} のクロールの許可が無い → ` +
      `cd ../capture-ledger && pnpm run fga:grant submitter ${me.subject} ${org}`,
  };
};
