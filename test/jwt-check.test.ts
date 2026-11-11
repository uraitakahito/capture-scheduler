/**
 * jwt の点検の読み分け。
 *
 * 要になるのは「拒まれた」の 3 通り —— ヘッダの設定・見分けられない (capture-ledger が古い)・
 * トークンそのものを拒んだ。どれも以前は「OIDC_ISSUER を書いて」の 1 通りだった。
 */
import { describe, expect, it } from "vitest";

import { readJwt } from "../scripts/doctor/jwt-check.js";

const ISS = "http://127.0.0.1:4566/us-east-1_example";
const need = (verdict: ReturnType<typeof readJwt>): string => (verdict.ok ? "" : verdict.need);

describe("readJwt", () => {
  it("200 なら ✓（ヘッダには訊かない）", () => {
    expect(readJwt({ token: 200, iss: ISS })).toEqual({ ok: true });
  });

  it("ヘッダで 200 なら、ヘッダの設定と名指しし、flow の資格の iss で OIDC_ISSUER を書かせる", () => {
    const verdict = readJwt({ token: 401, header: { status: 200, body: "{}" }, iss: ISS });
    expect(need(verdict)).toMatch(/ヘッダで名乗る設定/);
    expect(need(verdict)).toContain(`CAPTURE_LEDGER_OIDC_ISSUER=${ISS}`);
    // 直す手は、connect で引き渡しの行を全部写すこと (1 行ずつ書かせると、残りを書き漏らす)。
    expect(need(verdict)).toMatch(/pnpm run dev:up --from idp/);
  });

  it("ヘッダでも 401 なら、トークンを拒んだと言い、iss・client の ID・直し方・ログを挙げる", () => {
    const verdict = readJwt({
      token: 401,
      header: { status: 401, body: '{"error":"unauthenticated"}' },
      iss: ISS,
    });
    expect(need(verdict)).toMatch(/受けない/);
    expect(need(verdict)).not.toMatch(/ヘッダで名乗る設定で動いている/);
    for (const hint of [
      ISS,
      "CAPTURE_LEDGER_OIDC_CLIENT_IDS",
      "dev:up --from idp",
      "JWT rejected",
    ]) {
      expect(need(verdict)).toContain(hint);
    }
  });

  it("/api/me が無い（capture-ledger が古い）なら、見分けられないと言う", () => {
    const verdict = readJwt({
      token: 401,
      header: {
        status: 404,
        body: '{"message":"Route GET:/api/me not found","error":"Not Found","statusCode":404}',
      },
      iss: ISS,
    });
    expect(need(verdict)).toMatch(/v0\.42\.0 より古く/);
  });

  it("flow の資格でトークンが取れなければ、idp の行を先に見させる", () => {
    expect(need(readJwt({ token: "no-token", iss: ISS }))).toMatch(/上の idp を先に/);
  });

  it("API に届かなければ、API の行を先に見させる", () => {
    expect(need(readJwt({ token: undefined, iss: ISS }))).toMatch(/capture-ledger api/);
  });

  it("401 でない失敗は、status をそのまま出す（名乗りの問題にしない）", () => {
    const verdict = readJwt({ token: 500, iss: ISS });
    expect(need(verdict)).toMatch(/→ 500/);
    expect(need(verdict)).not.toMatch(/OIDC_ISSUER/);
  });
});
