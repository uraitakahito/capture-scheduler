#!/usr/bin/env node
/**
 * 立ち上がったばかりの Windmill に workspace と API token を用意する。
 *
 * compose に書けない仕事なので、ここに置いている —— container-compose には
 * 使い捨てのサービスが無い (subcommand は up / down / build / version の 4 つだけ)。
 * capture-ledger の `scripts/fga-migrate.mjs` と同じ立場。
 *
 * **token は .env に書かず、貼れる形で標準出力に出す。** `fga:deploy` と同じ作法。
 * 書き込む側にすると、`.env` を持つのが人間なのかスクリプトなのかが曖昧になる。
 *
 * **capture-ledger の `.env` の末尾に貼る 4 行も出す**（webhook の URL と token、待ち受け、issuer ——
 * `env.ts` の `ledgerEnv`）。どれもここで決まるか決め打ちの値で、人に組み立てさせると古くなる。
 * 以前は webhook の 2 行だけを出していて、残り 2 行を書き漏らした API で 2 度止まった。
 *
 * workspace は、既にあれば作り直さない。**token は毎回作る** —— 値は作ったときにしか読めないので、
 * 出せるのは作ったばかりのものだけ。前に作った token は残り、使えるまま。
 */
import {
  guardEnv,
  ledgerEnv,
  ledgerIssuer,
  optional,
  windmillFetch,
  windmillUrl,
  windmillWorkspace,
} from "./env.js";

guardEnv();

const EMAIL = optional("WINDMILL_EMAIL", "admin@windmill.dev");
const PASSWORD = optional("WINDMILL_PASSWORD", "changeme");

/** 冷えた Windmill は 30 秒ほど 500 を返す。DB の migration が終わるまで。 */
const ATTEMPTS = 60;
const DELAY_MS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForWindmill = async () => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${windmillUrl()}/api/version`);
      if (res.ok) return;
    } catch {
      // まだ listen していない。
    }
    if (attempt === 1) process.stderr.write(`${windmillUrl()} を待っています`);
    else process.stderr.write(".");
    await sleep(DELAY_MS);
  }
  process.stderr.write("\n");
  throw new Error(
    `${windmillUrl()} が ${String(ATTEMPTS)} 秒待っても応答しません ` +
      "(container-compose up -d は済んでいますか)",
  );
};

const login = async () => {
  // 素の文字列としてトークンが返る。
  const token = await windmillFetch("/api/auth/login", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  if (typeof token !== "string" || token === "") {
    throw new Error("login が token を返しませんでした");
  }
  return token;
};

const ensureWorkspace = async (token: string, id: string) => {
  const existing = await windmillFetch("/api/workspaces/list", { token });
  if (Array.isArray(existing) && existing.some((w: { id?: string }) => w.id === id)) {
    process.stderr.write(`workspace "${id}" は既にあります。\n`);
    return;
  }
  await windmillFetch("/api/workspaces/create", {
    token,
    method: "POST",
    // `username` は渡さない —— この配備では作成が自動化されているので、
    // 明示すると 400 ("username is not allowed when username creation is automated")。
    body: { id, name: id },
  });
  process.stderr.write(`workspace "${id}" を作りました。\n`);
};

/**
 * CLI と scripts/ が使う token。
 *
 * ログインで得た token をそのまま渡さないのは、あれがセッションのもので、
 * ログアウトや期限で消えるから。ここで作るのは明示的に消すまで残るもの。
 *
 * 前に作った token があっても作る (値はもう読めないので、貼れる形で出せない)。以前は作る前に
 * 「既にあります —— UI で消してからやり直して」と出していて、作った後なのに「やり直せ」と読めた。
 */
const LABEL = "capture-scheduler";

const createToken = async (session: string): Promise<{ token: string; earlier: boolean }> => {
  const existing = await windmillFetch("/api/users/tokens/list", { token: session });
  const earlier = Array.isArray(existing) && existing.some((t) => t.label === LABEL);
  const token = await windmillFetch("/api/users/tokens/create", {
    token: session,
    method: "POST",
    body: { label: LABEL },
  });
  return { token: String(token), earlier };
};

const main = async () => {
  await waitForWindmill();
  process.stderr.write("\n");

  const session = await login();
  const workspace = windmillWorkspace();
  await ensureWorkspace(session, workspace);
  const { token, earlier } = await createToken(session);
  process.stderr.write(
    earlier
      ? `新しい token を作りました (label "${LABEL}"。前に作った token も残っていて使えますが、値はもう読めません)。\n`
      : `token を作りました (label "${LABEL}")。\n`,
  );

  process.stderr.write("\n── この repo (capture-scheduler) の .env ──\n");
  // 貼れる形で **標準出力へ**。stderr との分離は意図的で、
  // `pnpm run windmill:bootstrap | tail -1` が使える。
  process.stdout.write(`WINDMILL_TOKEN=${token}\n`);

  // 標準出力は `WINDMILL_TOKEN=` の 1 行のまま (上の約束)。こちらは標準エラーへ出す。
  process.stderr.write(
    "\n── capture-ledger の .env の末尾に。4 行とも (同じ名前の行が前にあっても、後ろの行が効きます) ──\n" +
      "# capture-scheduler の pnpm run windmill:bootstrap が出した 4 行\n" +
      `${ledgerEnv({ windmillUrl: windmillUrl(), workspace, token, issuer: ledgerIssuer() }).join("\n")}\n\n` +
      "貼ったら capture-ledger の API を起こし直します (設定は起動のときに 1 回だけ読みます)。\n" +
      "起動ログの最後の行が「crawl level reports: ready」なら、4 行は効いています。\n",
  );
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
