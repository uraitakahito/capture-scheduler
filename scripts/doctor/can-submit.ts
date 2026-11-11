/**
 * capture-ledger の `GET /api/me` の答えを、doctor の can_submit の 1 行に読む。
 *
 * 訊くのは **flow が使うのと同じ資格で取ったトークン** (Windmill の変数 `u/admin/ledger_client`)。
 * capture-ledger は、そのトークンから解いた主体 (機械なら app client の ID) と組織をそのまま返すので、
 * 足りない許可を打つべきコマンドの形で名指しできる。機械の組織はトークンに載らず、capture-ledger が保存した許可から引く。
 *
 * 読み分けるのは status と本文。直すものがそれぞれ違う:
 *
 *   200 canSubmit: true     ✓
 *   200 canSubmit: false    その主体に、その組織のクロールの許可が無い → fga:grant
 *   200 組織が空            許可が 1 つも無い (機械の組織は許可から引く) → idp:grant
 *   401                     トークンが通らない (Floci のプールを作り直した・API がヘッダの設定)
 *   404 Route GET:/api/me   capture-ledger が古い (`GET /api/me` は v0.42.0 から)
 *   届かない・それ以外       そのまま出す
 *
 * 入出力を持たない。訊くのは `checks.ts`。
 */
import type { Verdict } from "./run.js";

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
        "Windmill のトークンが通らない —— Floci のプールを作り直したか、API が JWT を受けていない" +
        " (上の jwt)。cd ../capture-ledger && pnpm run dev:up --from idp",
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
        `${me.subject} の組織が無い —— 機械 (Windmill の app client) の組織は、capture-ledger が保存した許可から引く。` +
        "許可が 1 つも無い → cd ../capture-ledger && pnpm run idp:grant",
    };
  }
  return {
    ok: false,
    need:
      `${me.subject} に ${org} のクロールの許可が無い → ` +
      `cd ../capture-ledger && pnpm run fga:grant submitter ${me.subject} ${org}`,
  };
};
