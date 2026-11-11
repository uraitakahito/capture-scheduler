/**
 * Windmill の flow が capture-ledger に名乗るための、app client の設定とトークンの取り方。
 *
 * capture-ledger の IdP は Amazon Cognito。手元は代役の Floci で、capture-ledger の compose のサービス `idp` に在る
 * (CAPTURE-185)。flow は機械なので、人のサインインではなく client credentials で M2M の access token を取る。
 * トークンは最長 1 日しかもたないので、変数に入れて使い回さず、使うたびに取る。
 *
 * 値を決めるのは capture-ledger の `pnpm run idp:bootstrap` で、引き渡しファイル `.dev/idp.env` に書く。
 * **跨ぐときは読むだけ** —— こちらはそれを読みに行き (`readIdpHandoff`)、Windmill の変数
 * `u/admin/ledger_client` (secret・JSON) に入れる (`windmill:capture-ledger-token`)。
 * flow・doctor・smoke は、その変数から読む。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { optional, repoRoot } from "./env.js";

/** flow と点検が読む変数。 */
export const LEDGER_CLIENT_VAR = "u/admin/ledger_client";

/** 前の形の変数 (30 日のトークン)。`windmill:capture-ledger-token` が見つけたら消す。 */
export const RETIRED_TOKEN_VAR = "u/admin/waggle_token";

/** capture-ledger の引き渡しファイル。capture-ledger の `src/tools/idp.ts` の IDP_HANDOFF と同じ綴り。 */
export const IDP_HANDOFF = ".dev/idp.env";

export interface LedgerClient {
  /** トークンの iss。capture-ledger が照らす値で、その下に鍵 (JWKS) と discovery が在る。 */
  issuer: string;
  /** flow (コンテナ) から届く token endpoint。 */
  tokenUrl: string;
  /** host (doctor・smoke) から届く token endpoint。node はコンテナの名前に届かない。 */
  hostTokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

/** capture-ledger の置き場。dev:up は位置引数で渡す (worktree のように横並びでないときのため)。 */
export const ledgerDir = (given?: string): string =>
  resolve(repoRoot(), given ?? optional("CAPTURE_LEDGER_DIR", "../capture-ledger"));

/** `名前=値` の行のファイルを読む。無ければ undefined。 */
export const readIdpHandoff = (dir: string): Record<string, string> | undefined => {
  const path = resolve(dir, IDP_HANDOFF);
  if (!existsSync(path)) return undefined;
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (line.startsWith("#") || at <= 0) continue;
    values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
};

/** 引き渡しファイルの値から、変数に入れる形を組む。足りなければ、足りない名前を投げる。 */
export const ledgerClientFrom = (handoff: Record<string, string>): LedgerClient => {
  const need = (name: string): string => {
    const value = handoff[name];
    if (value === undefined || value === "") {
      throw new Error(
        `引き渡しファイルに ${name} が無い —— capture-ledger で pnpm run idp:bootstrap`,
      );
    }
    return value;
  };
  return {
    issuer: need("IDP_ISSUER"),
    tokenUrl: need("IDP_CONTAINER_TOKEN_ENDPOINT"),
    hostTokenUrl: need("IDP_TOKEN_ENDPOINT"),
    clientId: need("IDP_WINDMILL_CLIENT_ID"),
    clientSecret: need("IDP_WINDMILL_CLIENT_SECRET"),
    scope: need("IDP_WINDMILL_SCOPE"),
  };
};

/** 変数の値 (JSON) を読む。形が違えば undefined。 */
export const parseLedgerClient = (raw: string | undefined): LedgerClient | undefined => {
  if (raw === undefined || raw === "") return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const keys = ["issuer", "tokenUrl", "hostTokenUrl", "clientId", "clientSecret", "scope"];
    return keys.every((key) => typeof value[key] === "string" && value[key] !== "")
      ? (value as unknown as LedgerClient)
      : undefined;
  } catch {
    return undefined;
  }
};

/** client credentials の答え。届かなければ status は undefined。 */
export interface TokenAnswer {
  status: number | undefined;
  token?: string;
  body: string;
}

/** host から client credentials でトークンを取る。 */
export const hostClientCredentials = async (client: LedgerClient): Promise<TokenAnswer> => {
  try {
    const res = await fetch(client.hostTokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(client.scope)}`,
    });
    const body = await res.text();
    let token: unknown;
    try {
      token = (JSON.parse(body) as { access_token?: unknown }).access_token;
    } catch {
      token = undefined;
    }
    return {
      status: res.status,
      body,
      ...(res.ok && typeof token === "string" && token !== "" && { token }),
    };
  } catch (err) {
    return { status: undefined, body: err instanceof Error ? err.message : String(err) };
  }
};
