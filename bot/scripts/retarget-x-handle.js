#!/usr/bin/env node
/*
 * REPOINT EVERY SAVED TEMPLATE AT THE NEW X ACCOUNT.
 *
 * "bisakah anda buatkan template tg bot yang pakai dexvra listing di ganti
 * twiternya jdi listingdexvra jadi saya ga nulis 1/1 lagi manual cape."
 *
 * The rename landed in the code defaults (X_LISTING_HANDLE), and on a box where
 * a template was ever edited the code default does not win: templates.js says
 * so at its own header — anything saved in @dexvraadminbot lives in
 * data/templates.json and BEATS the shipped copy. So the advice was "hit
 * ♻️ Reset default on the four cards that name the account", and that advice is
 * bad: Reset throws away every OTHER edit on those cards to fix one word.
 *
 * This changes the word and keeps the rest.
 *
 * ⚠️ IT NEVER TOUCHES THE TELEGRAM CHANNEL. @dexvralisting on Telegram did not
 * move; only the X account did, and the two names are one transposition apart.
 * The intro cards carry BOTH on adjacent lines:
 *
 *     🚨 Launch post on [@dexvralisting](https://t.me/dexvralisting)   ← stays
 *     𝕏 Automatic post on X — [@dexvralisting]({xlisting})            ← changes
 *
 * So the decision is made per LINK, by its URL, never by the text: a markdown
 * link is rewritten only when it points at {xlisting} or at x.com/twitter.com.
 * A t.me link is left alone whatever its label says.
 *
 * ⚠️ AND EVERY REWRITE IS LENGTH-PRESERVING, WHICH IS WHY IT IS SAFE AT ALL.
 * A saved template can be an OBJECT — `{ text, entities }` — because the
 * premium-markup editor stores bold/link ranges as character OFFSETS into the
 * text. Any edit that changes the length shifts every entity after it, which
 * silently corrupts the card's formatting. `dexvralisting` and `listingdexvra`
 * are both 13 characters, so the swap moves nothing: the entities are correct
 * afterwards by construction, not by luck of nobody having used them.
 *
 * Dry run is the default; `--apply` is the only thing that writes, and it backs
 * the file up first — the `listings:fix` / `listings:nostables` contract. It is
 * idempotent: a second run finds nothing to do.
 *
 * The account it renames FROM defaults to the old handle and can be overridden
 * with a `--from=` argument naming a bare handle. No example is printed for it:
 * this file's own repo rule is that a pasteable command carries real values or
 * is not a command, and only the operator knows which account they mean.
 */
// ⚠️ ORDER, not presence: loadEnv() runs BEFORE any repo require, because
// config/constants.js freezes every value at require time — a script that
// reads an empty environment reports it as a fact about the server.
require("../src/config/loadEnv").loadEnv();
const fss = require("node:fs");
const path = require("node:path");
const tpl = require("../src/templates");
const { X_LISTING_HANDLE, X_LISTING_URL } = require("../src/config/constants");
const { DATA_DIR } = require("../src/helpers/persist");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const fromArg = (args.find((a) => a.startsWith("--from=")) || "").split("=")[1];
const OLD = String(fromArg || "dexvralisting").replace(/^@/, "");
const NEW = String(X_LISTING_HANDLE).replace(/^@/, "");

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", O = "\x1b[0m";
const ok = (m) => console.log(`${G}✔${O} ${m}`);
const bad = (m) => console.log(`${R}✘${O} ${m}`);
const warn = (m) => console.log(`${Y}!${O} ${m}`);
const dim = (m) => console.log(`${D}${m}${O}`);
const head = (m) => console.log(`\n${m}\n${"─".repeat(m.length)}`);

// The build stamp, for the reason every check script in this repo prints one:
// every round of this begins with somebody reading an output as a statement
// about the fix they just deployed.
const build = () => {
  try {
    const sha = require("node:child_process").execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = require("node:child_process").execSync("git status --porcelain", { encoding: "utf8" }).trim();
    return sha + (dirty ? "+dirty" : "");
  } catch {
    return "unknown";
  }
};

/** Is this URL our own X account's, rather than Telegram's or a project's? */
const isOurX = (url) => {
  const u = String(url || "").trim();
  if (u === "{xlisting}") return true;
  return new RegExp(`(?:^|//|\\.)(?:x|twitter)\\.com/@?${OLD}\\b`, "i").test(u);
};

/**
 * Rewrite one saved template VALUE. Returns { out, hits, ambiguous }.
 *
 * Decisions are made per LINK and per URL — never per line and never on the
 * label text, because the label is exactly what is identical between the two
 * accounts.
 *
 * ⚠️ A URL DOES NOT HAVE TO BE IN THE TEXT. A template pasted with authored
 * formatting is stored as `{ text, entities }`, and a `text_link` entity keeps
 * its target in `entity.url` — nowhere in the text at all. The first cut of
 * this script scanned the text only and answered "nothing to rename" over a
 * welcome card whose Official Links row still opened
 * `https://x.com/dexvralisting?s=11`. A rename tool that reports a clean box
 * while the link is still wrong is worse than no tool: it ends the search.
 * (The `?s=11` is the giveaway that it was pasted from the X mobile app — an
 * operator's hand-made link, which is exactly the kind {xlisting} never gets
 * used for.)
 *
 * Rewriting an entity's url cannot move a single character, and every text
 * swap is length-preserving, so offsets stay correct either way.
 *
 * `xOnly` marks a template in the "X Posts" group — the TWEET copy. There is no
 * Telegram inside a tweet, so a bare @mention there can only be the X account
 * and is swapped rather than handed back to the operator to read. That is the
 * one place the ambiguity below does not exist, and leaving those in the
 * "read these yourself" pile is the manual work this script exists to end.
 */
function retargetValue(val, xOnly) {
  const isObj = val && typeof val === "object" && val.text != null;
  const text = isObj ? val.text : String(val || "");
  let hits = 0;
  const swap = (s) => String(s).replace(new RegExp(OLD, "g"), () => (hits++, NEW));

  // 1. Markdown links: `[label](url)`. Rewritten only when the URL is ours.
  let out = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (whole, label, url) =>
    isOurX(url) ? `[${swap(label)}](${swap(url)})` : whole,
  );

  // 2. Bare URLs outside a link — an operator who pasted the profile address
  //    rather than using {xlisting}. Same host, new handle; any ?s= suffix the
  //    X app appended is left exactly as it was.
  out = out.replace(new RegExp(`((?:https?://)?(?:www\\.)?(?:x|twitter)\\.com/)@?${OLD}\\b`, "gi"), (_m, pre) => {
    hits++;
    return `${pre}${NEW}`;
  });

  // 3. text_link ENTITIES — the url the reader actually opens, which lives
  //    outside the text entirely. Only ours; a project's own X link and every
  //    t.me link are left alone.
  let entities = isObj ? val.entities : null;
  if (Array.isArray(entities)) {
    // ⚠️ WHICH ENTITIES ARE OURS IS DECIDED FIRST, ONCE. isOurX() tests for the
    // OLD handle, so asking it again after the urls have been rewritten answers
    // NO for every entity this pass just fixed — and the label swap below then
    // silently skipped every one of them. Caught by the test, not by reading.
    const ours = entities.map((e) => Boolean(e && e.type === "text_link" && isOurX(e.url)));
    // The LABEL that entity covers, when it spells the handle out. Bounded to
    // the entity's own range, so a mention elsewhere on the card is untouched —
    // and done BEFORE the url swap, on the ranges as they stand.
    entities.forEach((e, i) => {
      if (!ours[i]) return;
      const covered = out.slice(e.offset, e.offset + e.length);
      const fixed = swap(covered);
      if (fixed !== covered) out = out.slice(0, e.offset) + fixed + out.slice(e.offset + e.length);
    });
    // …then the url the reader actually opens, which lives outside the text
    // entirely. A project's own X link and every t.me link are left alone.
    entities = entities.map((e, i) => (ours[i] ? { ...e, url: swap(e.url) } : e));
  }

  // 3b. In a TWEET, a bare @mention has no other candidate. Everywhere else it
  //     is the Telegram channel on every card this repo ships, which is why the
  //     general case falls through to the report below.
  if (xOnly) out = swap(out);

  // 4. What is LEFT is reported, never guessed at. A bare `@dexvralisting` with
  //    no link around it is the Telegram channel on every card this repo ships
  //    — and could be the X account on a card an operator rewrote by hand. The
  //    code cannot tell, so a human does; that is a handful of lines to read,
  //    not the one-by-one edit this script exists to end.
  const linked = new Set(
    (Array.isArray(entities) ? entities : [])
      .filter((e) => e && e.type === "text_link")
      .map((e) => out.slice(e.offset, e.offset + e.length)),
  );
  const ambiguous = out
    .split("\n")
    .filter((line) => new RegExp(`@?${OLD}\\b`, "i").test(line) && !/t\.me\//i.test(line) && !linked.has(line.trim()))
    .map((l) => l.trim());

  return { out: isObj ? { ...val, text: out, entities } : out, hits, ambiguous, isObj, before: text };
}

(async () => {
  head("Environment");
  console.log(`  build              ${build()}`);
  console.log(`  data dir           ${DATA_DIR}`);
  console.log(`  X account is now   @${NEW}  ${D}${X_LISTING_URL}${O}`);
  console.log(`  renaming from      @${OLD}`);
  if (OLD === NEW) {
    bad("the two handles are the same — nothing to rename");
    process.exit(1);
  }

  const file = path.join(DATA_DIR, "templates.json");
  if (!fss.existsSync(file)) {
    head("Saved templates");
    ok("no templates.json on this box — every card is the shipped default, which already names the new account");
    process.exit(0);
  }

  head("Saved templates");
  // Only the templates an admin actually SAVED can be stale: an untouched card
  // renders from DEFAULTS, which the code rename already fixed.
  const custom = tpl.keys().filter((k) => tpl.isCustom(k));
  dim(`  ${custom.length} of ${tpl.keys().length} template(s) have an admin-saved override`);

  const changes = [];
  const toRead = [];
  for (const key of custom) {
    const val = tpl.getRawValue(key);
    const m = tpl.meta(key);
    const xOnly = !!(m && m.group === "X Posts");
    const { out, hits, ambiguous, isObj, before: text } = retargetValue(val, xOnly);
    if (hits) {
      // The invariant this whole script rests on, ASSERTED rather than trusted:
      // an entity-bearing template whose length moved would have its bold and
      // link ranges silently shifted.
      const outText = isObj ? out.text : out;
      if (outText.length !== text.length) {
        bad(`${key}: rewrite changed the length (${text.length} → ${outText.length}) — refusing, entities would shift`);
        continue;
      }
      changes.push({ key, isObj, out, outText, hits, before: text, urlOnly: outText === text });
    }
    if (ambiguous.length) toRead.push({ key, lines: ambiguous });
  }

  if (!changes.length) {
    ok(`nothing to rename — no saved template still points at @${OLD}`);
  } else {
    for (const c of changes) {
      console.log(`\n  ${c.key}  ${D}(${c.hits} occurrence${c.hits > 1 ? "s" : ""}${c.isObj ? ", has entities" : ""})${O}`);
      if (c.urlOnly) console.log(`    ${D}(the text is unchanged — the link lives in a formatting entity)${O}`);
      const b = c.before.split("\n");
      c.outText.split("\n").forEach((line, i) => {
        if (b[i] !== line) {
          console.log(`    ${R}- ${b[i]}${O}`);
          console.log(`    ${G}+ ${line}${O}`);
        }
      });
    }
  }

  if (toRead.length) {
    head("Read these yourself");
    dim(`  @${OLD} on Telegram did NOT move, and these lines name it with no link to`);
    dim(`  decide from. On every shipped card that is the Telegram channel and is`);
    dim(`  correct as it stands — check them only if you rewrote one to mean X.`);
    for (const t of toRead) {
      console.log(`\n  ${t.key}`);
      for (const l of t.lines) console.log(`    ${l}`);
    }
  }

  if (!changes.length) process.exit(0);

  head("Result");
  if (!APPLY) {
    warn(`${changes.length} template(s) would be rewritten — this was a DRY RUN, nothing was saved`);
    dim("  Run it again with --apply to write the changes.");
    process.exit(0);
  }

  const backup = `${file}.bak.${Date.now()}`;
  fss.copyFileSync(file, backup);
  dim(`  backup: ${backup}`);
  for (const c of changes) {
    // setTemplate writes the whole value, so an object keeps its entities —
    // which are still correct because the length did not move.
    await tpl.setTemplate(c.key, c.out);
  }
  ok(`${changes.length} template(s) now name @${NEW}`);
  dim("  The bot reads templates.json on every render — no restart needed.");
})();
