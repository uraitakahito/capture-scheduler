/**
 * jwt の点検の読み分け。
 *
 * 要になるのは「拒まれた」の 3 通り —— ヘッダの設定・見分けられない (capture-ledger が古い)・
 * トークンそのものを拒んだ。どれも以前は「OIDC_ISSUER を書いて」の 1 通りだった。
 */
import { describe, expect, it } from "vitest";

import { readJwt } from "../scripts/doctor/jwt-check.js";

const ISS = "http://127.0.0.1:9099";
const need = (verdict: ReturnType<typeof readJwt>): string => (verdict.ok ? "" : verdict.need);

describe("readJwt", () => {
  it("200 なら ✓（ヘッダには訊かない）", () => {
    expect(readJwt({ token: 200, iss: ISS })).toEqual({ ok: true });
  });

  it("ヘッダで 200 なら、ヘッダの設定と名指しし、issuer の名乗りで OIDC_ISSUER を書かせる", () => {
    const verdict = readJwt({ token: 401, header: { status: 200, body: "{}" }, iss: ISS });
    expect(need(verdict)).toMatch(/ヘッダで名乗る設定/);
    expect(need(verdict)).toContain(`CAPTURE_LEDGER_OIDC_ISSUER=${ISS}`);
  });

  it("ヘッダでも 401 なら、トークンを拒んだと言い、iss・aud・30 秒・ログを挙げる", () => {
    const verdict = readJwt({
      token: 401,
      header: { status: 401, body: '{"error":"unauthenticated"}' },
      iss: ISS,
    });
    expect(need(verdict)).toMatch(/受けない/);
    expect(need(verdict)).not.toMatch(/ヘッダで名乗る設定で動いている/);
    for (const hint of [ISS, "AUDIENCE", "30 秒", "JWT rejected"]) {
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

  it("issuer からトークンが取れなければ、issuer の行を先に見させる", () => {
    expect(need(readJwt({ token: "no-token", iss: ISS }))).toMatch(/oidc issuer/);
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
