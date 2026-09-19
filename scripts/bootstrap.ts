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
 * **capture-ledger の `.env` に貼る 2 行も出す**（webhook の URL と token）。どちらも
 * ここで決まる値で、人に組み立てさせると古くなる (`env.ts` の `CRAWL_FLOW_PATH` を見ること)。
 *
 * 冪等: workspace も token も、既にあれば作り直さない。
 */
import {
  guardEnv,
  ledgerWebhookEnv,
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
 */
const createToken = async (token: string) => {
  const label = "capture-scheduler";
  const existing = await windmillFetch("/api/users/tokens/list", { token });
  if (Array.isArray(existing) && existing.some((t) => t.label === label)) {
    process.stderr.write(
      `label "${label}" の token は既にあります —— **値は二度と読めません**。\n` +
        "  .env に貼っていないなら、Windmill の UI で消してからやり直してください。\n",
    );
  }
  return windmillFetch("/api/users/tokens/create", {
    token,
    method: "POST",
    body: { label },
  });
};

const main = async () => {
  await waitForWindmill();
  process.stderr.write("\n");

  const session = await login();
  const workspace = windmillWorkspace();
  await ensureWorkspace(session, workspace);
  const token = await createToken(session);

  process.stderr.write("\n以下を .env に貼ってください:\n\n");
  // 貼れる形で **標準出力へ**。stderr との分離は意図的で、
  // `pnpm run windmill:bootstrap | tail -1` が使える。
  process.stdout.write(`WINDMILL_TOKEN=${String(token)}\n`);

  // 標準出力は `WINDMILL_TOKEN=` の 1 行のまま (上の約束)。こちらは標準エラーへ出す。
  process.stderr.write(
    `\ncapture-ledger の .env にも、次の 2 行を貼ってください:\n\n${ledgerWebhookEnv({
      windmillUrl: windmillUrl(),
      workspace,
      token: String(token),
    }).join("\n")}\n`,
  );
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
