// The bot is custodial: every user's funds sit behind ONE value, WALLET_SECRET,
// and a ciphertext store that is useless without it. Nowhere was it written down
// where that secret lives, and the archive it protects had never once been
// restored. A backup you have never restored is not a backup, it is an
// assumption — and this is the one assumption that cannot be checked after the
// fact.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const test = require("node:test");
const assert = require("node:assert");

const SCRIPT = path.join(__dirname, "scripts", "restore-drill.js");
const SRC = fs.readFileSync(SCRIPT, "utf8");
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Run the drill; returns { status, out } and never throws on a non-zero exit. */
function run(args, env = {}) {
  try {
    const out = execFileSync("node", [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status == null ? 1 : e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}
const tmp = (name, body) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-drill-"));
  const p = path.join(d, name);
  fs.writeFileSync(p, body);
  return p;
};

test("it refuses to run without the secret, instead of pretending to pass", () => {
  const r = run([tmp("s.json", "{}")], { WALLET_SECRET: "" });
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /WALLET_SECRET is not set/);
});

test("a truncated archive is caught before anything else", () => {
  // The other half of the failure: the secret is fine but the file is short.
  const r = run([tmp("cut.json", '{"users":{"1":{"wal')], { WALLET_SECRET: "0123456789abcdef0123" });
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /not valid JSON \(truncated\?\)/);
});

test("a file that is not a tradebot store is rejected by name", () => {
  const r = run([tmp("other.json", '{"hello":"world"}')], { WALLET_SECRET: "0123456789abcdef0123" });
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /no `users` object/);
});

test("an empty store is not a pass — it proves nothing about the secret", (t) => {
  // The trap: a drill that says ✅ against a store with no wallets in it would
  // certify a secret that has never decrypted anything.
  const r = run([tmp("empty.json", '{"users":{},"refByCode":{},"report":null}')], { WALLET_SECRET: "0123456789abcdef0123" });
  // This case gets far enough to load core.js, which needs the real deps.
  if (/could not load core\.js/.test(r.out)) return t.skip("deps not installed in this checkout");
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /proves nothing about your secret/);
});

test("the proof is derive-and-compare, not 'it parsed'", () => {
  // Decrypting to SOMETHING proves nothing — AES-GCM would reject a wrong key,
  // but a store restored from the wrong host could decrypt cleanly and hold
  // another deployment's wallets. Deriving the address from the key and
  // matching it against the address stored beside it is the actual proof.
  assert.match(code, /const derived = core\.walletFromSecret\(key\)\.address;/);
  assert.match(code, /String\(derived\)\.toLowerCase\(\) === String\(w\.address\)\.toLowerCase\(\)/);
  assert.match(code, /EVM keys verified \(decrypt → address matches\)/);
});

test("it drills the REAL decrypt path, not a copy of the crypto", () => {
  // A drill that reimplements scrypt+AES proves only that the drill can decrypt
  // the file. It has to go through the same code the bot uses to sign a trade.
  assert.match(code, /core = require\('\.\.\/core'\)/);
  assert.match(code, /core\.exportKey\(u\.chatId, w\.id, 'ethereum'\)/);
  assert.match(code, /core\.exportKey\(u\.chatId, w\.id, 'solana'\)/, "both curves, one wallet");
  assert.ok(!/createDecipheriv|scryptSync/.test(code), "the drill must not carry its own crypto");
});

test("no private key, seed or secret is ever printed", () => {
  // This is run on a VPS, often over a shared screen, and its output gets pasted
  // into chats. One console.log of `key` would leak every custodial wallet.
  const prints = code.match(/console\.(log|error)\([\s\S]*?\);/g) || [];
  assert.ok(prints.length > 3, "sanity: the script does print things");
  // Only the INTERPOLATED values can leak — the English prose around them can
  // say "secret" all it likes, and has to, to explain itself.
  const banned = /\bkey\b|walletSecret|WALLET_SECRET|\benc\b|solEnc|privateKey|mnemonic|\bplain\b|\braw\b/;
  for (const p of prints) {
    for (const expr of p.match(/\$\{[^}]*\}/g) || []) {
      assert.ok(!banned.test(expr), `prints a secret: ${expr} in ${p.slice(0, 80)}`);
    }
  }
  // The decrypted key is bound to a local and used for derivation only. Check
  // EVERY interpolation in the file, not just the console calls — `failures`
  // is printed later, so anything pushed into it is printed too.
  assert.match(code, /const key = core\.exportKey/);
  for (const expr of code.match(/\$\{[^}]*\}/g) || []) {
    assert.ok(!banned.test(expr), `an interpolated secret would reach the terminal: ${expr}`);
  }
});

test("the live store is never written to — a rehearsal must not be a second way to lose it", () => {
  assert.match(code, /const scratch = fs\.mkdtempSync\(/);
  assert.match(code, /process\.env\.DATA_DIR = scratch;/, "core.js resolves DATA_DIR at load, so this must come first");
  assert.ok(code.indexOf("process.env.DATA_DIR = scratch") < code.indexOf("require('../core')"), "…and it does");
  assert.match(code, /fs\.rmSync\(scratch, \{ recursive: true, force: true \}\)/, "and it cleans up after itself");
});

test("a failure explains the one dangerous next move", () => {
  // The instinct after "wrong secret" is to start the bot anyway and see. That
  // mints new wallets under the wrong secret, which the RIGHT secret can then
  // never open — turning a recoverable mistake into an unrecoverable one.
  assert.match(SRC, /Do NOT start the bot with it/);
  assert.match(SRC, /a NEW wallet minted under it would be unrecoverable/);
});

test("the runbook exists, and names the drill", () => {
  // A recovery procedure that lives in someone's head is not a procedure.
  const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "DISASTER-RECOVERY.md"), "utf8");
  assert.match(doc, /restore-drill\.js/, "the doc must point at the tool that verifies it");
  assert.match(doc, /WALLET_SECRET/);
  for (const section of ["What is at stake", "Where the secret lives", "Restore procedure", "The drill"]) {
    assert.ok(doc.includes(section), `the runbook has no "${section}" section`);
  }
  // A runbook without a schedule is a document nobody opens again.
  assert.match(doc, /monthly/i, "it must say how often to rehearse");
});
