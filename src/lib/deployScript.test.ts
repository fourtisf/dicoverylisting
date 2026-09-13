/*
 * deployScript.test.ts — scripts/deploy.sh is DRIVEN, not read.
 *
 * `bash -n` proves syntax, and every defect this repo has had in a script was a
 * runtime shape: a probe that hung, a scan that reported a busy pair as dead, a
 * check that named the wrong layer. The deploy script decides which of four
 * processes to restart and then asserts what each one is running, so what has
 * to be measured is what it RUNS — not what it says.
 *
 * It is driven against a real temp git repo (the script does real fetch/merge)
 * with `npm`, `pm2` and `curl` stubbed on PATH. The pm2 stub models the one
 * thing the verification turns on: `pm2 logs --nostream` reads a FILE that
 * still holds every earlier boot, so a new line has to be waited for rather
 * than read off the end.
 */
import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = fs.readFileSync(path.join(REPO, "scripts", "deploy.sh"), "utf8");

type World = { dir: string; stub: string; run: (...args: string[]) => { out: string; code: number } };

function sh(cwd: string, cmd: string) {
  return execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repo with an origin, the real script, and stubbed npm/pm2/curl. */
function world(procs = ["dexvra-bot", "dexvra-adminbot", "dexvra-tradebot"]): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dep-"));
  const origin = path.join(root, "origin.git");
  const dir = path.join(root, "work");
  const stub = path.join(root, "stub");
  fs.mkdirSync(stub, { recursive: true });

  sh(root, `git init --bare -q "${origin}"`);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, `git init -q -b main && git config user.email t@t && git config user.name t`);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "bot"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tradebot"), { recursive: true });
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "deploy.sh"), SCRIPT);
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "bot", "ecosystem.config.js"), "module.exports={}\n");
  fs.writeFileSync(path.join(dir, "bot", "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "tradebot", "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "src.txt"), "web\n");
  sh(dir, `git add -A && git commit -qm base && git remote add origin "${origin}" && git push -q origin main`);

  // Each process's log starts with ONE old boot line, exactly as a box that has
  // been up for a while does — so a verification that reads the end of the file
  // without waiting reports the OLD sha as current.
  fs.writeFileSync(path.join(stub, "procs"), procs.join("\n") + "\n");
  fs.writeFileSync(path.join(stub, "newsha"), "0000000");
  for (const p of procs) fs.writeFileSync(path.join(stub, `log_${p}`), "[boot] build 0000000\n");
  fs.writeFileSync(path.join(stub, "calls"), "");

  fs.writeFileSync(path.join(stub, "pm2"), `#!/usr/bin/env bash
S="${stub}"
echo "pm2 $*" >> "$S/calls"
boot() { echo "[boot] build $(cat "$S/newsha")" >> "$S/log_$1"; }
case "$1" in
  describe) grep -qx "$2" "$S/procs" && exit 0 || exit 1 ;;
  logs)     cat "$S/log_$2" 2>/dev/null; exit 0 ;;
  restart)
    # A real process takes a moment to boot and print. $S/bootdelay models that,
    # which is the only way a test can tell "read the end of the log" from
    # "wait for a line this restart produced".
    D="$(cat "$S/bootdelay" 2>/dev/null || echo 0)"
    if [ "$2" = "ecosystem.config.js" ]; then ( sleep "$D"; boot dexvra-bot; boot dexvra-adminbot ) &
    elif [ "$2" != "dexvra" ]; then ( sleep "$D"; boot "$2" ) & fi
    exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

  fs.writeFileSync(path.join(stub, "npm"), `#!/usr/bin/env bash
echo "npm $* (cwd=\${PWD##*/})" >> "${stub}/calls"
exit 0
`, { mode: 0o755 });

  fs.writeFileSync(path.join(stub, "curl"), `#!/usr/bin/env bash
echo "curl" >> "${stub}/calls"
printf '{"build":"%s"}' "$(cat "${stub}/websha" 2>/dev/null || cat "${stub}/newsha")"
exit 0
`, { mode: 0o755 });

  const run = (...args: string[]) => {
    try {
      const out = execFileSync("bash", ["scripts/deploy.sh", ...args], {
        cwd: dir, encoding: "utf8",
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { out, code: 0 };
    } catch (e: any) {
      return { out: String(e?.stdout ?? "") + String(e?.stderr ?? ""), code: e?.status ?? 1 };
    }
  };
  return { dir, stub, run };
}

/** Commit files upstream so the box has something to fast-forward to. */
function push(w: World, files: string[]) {
  for (const f of files) {
    const abs = path.join(w.dir, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, "x\n");
  }
  sh(w.dir, `git add -A && git commit -qm "change" && git push -q origin main`);
  const head = sh(w.dir, `git rev-parse --short HEAD`).trim();
  // Rewind so the script has a real pull to do, the way the box does.
  sh(w.dir, `git reset -q --hard HEAD~1`);
  fs.writeFileSync(path.join(w.stub, "newsha"), head);
  return head;
}

const calls = (w: World) => fs.readFileSync(path.join(w.stub, "calls"), "utf8");

/** The verification line for one process, with the colour codes stripped. */
function verdictLine(out: string, proc: string) {
  const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.split("\n").find((l) => l.startsWith(`· ${proc} `))?.trim() ?? "";
}

test("a tradebot-only change does not rebuild or restart the web app", () => {
  const w = world();
  push(w, ["tradebot/solana.js"]);
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  const c = calls(w);
  assert.ok(!/npm run build/.test(c), "a bot-only deploy must not pay for a Next build:\n" + c);
  assert.ok(!/pm2 restart dexvra --update-env/.test(c), "the web app must not be restarted");
  assert.ok(/pm2 restart dexvra-tradebot/.test(c), "the tradebot must be restarted");
  assert.ok(!/pm2 restart ecosystem/.test(c), "the bot suite is untouched by a tradebot change");
});

test("…and the web app being on an older commit is then NOT a failure", () => {
  // It is CORRECT for a bot-only deploy, and calling it red would leave this
  // command permanently red on a healthy box — the chart:preview state.
  const w = world();
  const before = sh(w.dir, `git rev-parse --short HEAD`).trim();
  push(w, ["tradebot/solana.js"]);
  fs.writeFileSync(path.join(w.stub, "websha"), before);
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no web file changed since/);
});

test("⚠️ but a web app behind on WEB files IS a failure", () => {
  // The real shape: an EARLIER deploy pulled a web change and left the web app
  // un-restarted. This deploy is tradebot-scoped, so it will not restart it
  // either — and that stale web app is now missing a web commit, which is the
  // one case where "older" is the wrong verdict.
  const w = world();
  const stale = sh(w.dir, `git rev-parse --short HEAD`).trim();           // A
  sh(w.dir, `echo a >> src.txt && git add -A && git commit -qm web`);     // B — already on the box
  sh(w.dir, `git push -q origin main`);
  sh(w.dir, `mkdir -p tradebot && echo x >> tradebot/x.js && git add -A && git commit -qm trade`);
  sh(w.dir, `git push -q origin main`);                                   // C — upstream only
  const head = sh(w.dir, `git rev-parse --short HEAD`).trim();
  sh(w.dir, `git reset -q --hard HEAD~1`);                                // the box sits at B
  fs.writeFileSync(path.join(w.stub, "newsha"), head);
  fs.writeFileSync(path.join(w.stub, "websha"), stale);                   // the web app never left A
  const r = w.run();
  assert.equal(r.code, 1, "a web app missing a web change must fail the deploy");
  assert.match(r.out, /behind on WEB files/);
});

test("a web-only change does not restart the bots", () => {
  const w = world();
  push(w, ["src.txt"]);
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  const c = calls(w);
  assert.ok(/npm run build/.test(c));
  assert.ok(/pm2 restart dexvra --update-env/.test(c));
  assert.ok(!/pm2 restart ecosystem/.test(c), "the bot suite is untouched by a web change");
  assert.ok(!/pm2 restart dexvra-tradebot/.test(c));
});

test("⚠️ shared/ restarts everything — it is required by all three packages", () => {
  const w = world();
  push(w, ["shared/launchpads.js"]);
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  const c = calls(w);
  assert.ok(/npm run build/.test(c), "shared/ reaches the web app");
  assert.ok(/pm2 restart ecosystem/.test(c), "shared/ reaches the bot suite");
  assert.ok(/pm2 restart dexvra-tradebot/.test(c), "shared/ reaches the tradebot");
});

test("the bot suite is restarted through the ECOSYSTEM FILE, never by name", () => {
  // Restarting dexvra-bot by name leaves dexvra-adminbot on the old code, which
  // fails silently and reads as a missing feature rather than a stale process.
  const w = world();
  push(w, ["bot/src/x.js"]);
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  const c = calls(w);
  assert.ok(/pm2 restart ecosystem\.config\.js/.test(c));
  assert.ok(!/pm2 restart dexvra-bot\b/.test(c), "never by name — the sibling would be left behind");
  assert.ok(!/pm2 restart dexvra-adminbot\b/.test(c));
});

test("⚠️ a bot that comes back on the WRONG sha fails the deploy", () => {
  const w = world();
  push(w, ["bot/src/x.js"]);
  fs.writeFileSync(path.join(w.stub, "newsha"), "deadbee");   // not what was checked out
  const r = w.run();
  assert.equal(r.code, 1, "the whole point of step 5 is that this is caught");
  assert.match(r.out, /the restart did not take/);
  assert.match(r.out, /not everything is running it/);
});

test("⚠️ and a STALE log line is never read as this boot", () => {
  // pm2 logs --nostream reads the file, which still holds every earlier boot.
  // Reading the end of it without waiting reports a three-day-old stamp as
  // current — the reassuring reading this verification exists to refuse. The
  // stub delays the new line so the two behaviours are distinguishable at all.
  const w = world();
  fs.writeFileSync(path.join(w.stub, "bootdelay"), "3");
  const head = push(w, ["bot/src/x.js"]);
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  const log = fs.readFileSync(path.join(w.stub, "log_dexvra-bot"), "utf8");
  assert.match(log, /^\[boot\] build 0000000/, "the old line is still first in the file");
  assert.ok(
    verdictLine(r.out, "dexvra-bot").includes(head),
    `it must wait for THIS boot, not read the old line: ${verdictLine(r.out, "dexvra-bot")}`,
  );
});

test("⚠️ an untouched bot on a real older commit is fine, not red", () => {
  // The permanently-red rule, on the branch the web app already had a test for.
  // A bot sitting on a commit whose bot/ and shared/ files match HEAD's is
  // CORRECT after a web-only deploy, and calling it stale teaches the reader to
  // ignore the red.
  const w = world();
  const old = sh(w.dir, `git rev-parse --short HEAD`).trim();
  for (const proc of ["dexvra-bot", "dexvra-adminbot", "dexvra-tradebot"]) {
    fs.writeFileSync(path.join(w.stub, `log_${proc}`), `[boot] build ${old}\n`);
  }
  push(w, ["src.txt"]);                       // web only
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.match(verdictLine(r.out, "dexvra-bot"), /older, and nothing of its own changed/);
});

test("⚠️ a +dirty stamp is a failure — that checkout is not what main says", () => {
  const w = world();
  const head = push(w, ["src.txt"]);          // web only: the bots are not restarted
  fs.writeFileSync(path.join(w.stub, "log_dexvra-bot"), `[boot] build ${head}+dirty\n`);
  const r = w.run();
  assert.equal(r.code, 1, "somebody edited files on the box — say so");
  assert.match(verdictLine(r.out, "dexvra-bot"), /uncommitted changes/);
});

test("⚠️ a process that prints no boot stamp at all is a failure", () => {
  // "did it start?" — a process pm2 lists but that never booted answers every
  // `pm2 describe` perfectly well.
  const w = world();
  push(w, ["src.txt"]);
  fs.writeFileSync(path.join(w.stub, "log_dexvra-adminbot"), "");
  const r = w.run();
  assert.equal(r.code, 1);
  assert.match(verdictLine(r.out, "dexvra-adminbot"), /no build stamp/);
});

test("nothing new to pull restarts nothing, and still verifies", () => {
  const w = world();
  fs.writeFileSync(path.join(w.stub, "newsha"), sh(w.dir, `git rev-parse --short HEAD`).trim());
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  const c = calls(w);
  assert.ok(!/npm run build/.test(c), "a second run is a report, not another rebuild");
  assert.ok(!/pm2 restart/.test(c), "nothing is restarted");
  assert.match(r.out, /nothing new to pull/);
  assert.match(r.out, /every process is on/, "it still says what is running");
});

test("--all forces everything even with nothing to pull", () => {
  const w = world();
  fs.writeFileSync(path.join(w.stub, "newsha"), sh(w.dir, `git rev-parse --short HEAD`).trim());
  const r = w.run("--all");
  assert.equal(r.code, 0, r.out);
  const c = calls(w);
  assert.ok(/npm run build/.test(c));
  assert.ok(/pm2 restart ecosystem/.test(c));
  assert.ok(/pm2 restart dexvra-tradebot/.test(c));
});

test("--with-bots still works — it is in CLAUDE.md and in muscle memory", () => {
  const w = world();
  push(w, ["src.txt"]);
  const r = w.run("--with-bots");
  assert.equal(r.code, 0, r.out);
  assert.ok(/pm2 restart ecosystem/.test(calls(w)));
});

test("a process this box does not run is skipped, not failed", () => {
  const w = world(["dexvra-bot", "dexvra-adminbot"]);   // no tradebot here
  push(w, ["shared/x.js"]);
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.ok(!/dexvra-tradebot/.test(r.out.replace(/pm2 describe.*/g, "")));
});

test("it refuses to deploy over uncommitted work", () => {
  const w = world();
  fs.writeFileSync(path.join(w.dir, "src.txt"), "edited on the box\n");
  const r = w.run();
  assert.equal(r.code, 1);
  assert.match(r.out, /working tree has changes/);
});

test("npm ci is not run for a package this deploy does not touch", () => {
  // `npm ci` DELETES node_modules and reinstalls — minutes spent to arrive at
  // the bytes already on disk.
  const w = world();
  push(w, ["tradebot/x.js"]);
  w.run();
  const c = calls(w);
  assert.ok(/npm ci .*cwd=tradebot/.test(c), "the package that changed is installed:\n" + c);
  assert.ok(!/npm ci .*cwd=bot\)/.test(c), "the one that did not is skipped");
});
