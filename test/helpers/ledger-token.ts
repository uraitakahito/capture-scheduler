import { vi } from "vitest";

/**
 * flow の段が capture-ledger に名乗るトークン。段は変数 `u/admin/ledger_client` から client の設定を読み、
 * client credentials でトークンを取ってから capture-ledger を叩く (`ledgerToken`。6 本が同じ物を持つ)。
 */
export const LEDGER_CLIENT = {
  tokenUrl: "http://idp.test:4566/cognito-idp/oauth2/token",
  clientId: "windmill-client",
  clientSecret: "windmill-secret",
  scope: "capture-ledger/crawl",
};

/** `u/admin/ledger_client` の値 (Windmill の変数は文字列なので JSON)。 */
export const LEDGER_CLIENT_VAR = JSON.stringify(LEDGER_CLIENT);

/** token endpoint が返すトークン。capture-ledger への頼みには `Bearer tok` が載る。 */
export const TOKEN = "tok";

/**
 * fetch の偽物を包む。token endpoint への頼みには `TOKEN` を返し、**中の偽物には渡さない** ——
 * 試験が記録しているのは capture-ledger への頼みだけで、その順と中身はトークンを取る前と同じになる。
 */
export const answeringToken = (inner: (url: string, init: RequestInit) => Promise<Response>) =>
  vi.fn((url: string, init: RequestInit) =>
    String(url) === LEDGER_CLIENT.tokenUrl
      ? Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ access_token: TOKEN, token_type: "Bearer" }),
          text: () => Promise.resolve(""),
        } as Response)
      : inner(url, init),
  );
