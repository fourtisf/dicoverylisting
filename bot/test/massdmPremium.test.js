// "harus pakai emoji premium kaya fourtis" — and it already does, because a DM
// is a PRIVATE chat.
//
// Telegram's rule: a bot may use custom-emoji entities if it holds a Fragment
// username, OR "in the messages directly sent by the bot to private, group and
// supergroup chats if the OWNER of the bot has a Telegram Premium
// subscription". A CHANNEL is in neither list — which is the whole reason
// channels/post.js reaches for the GramJS premium account, and the reason
// premium.js's old header said animation needs it. Applying that sentence to a
// DM is what made this feature read as unable to do something it does by
// itself.
//
// So nothing here makes the emoji animate; that is the BotFather owner's
// Premium. What IS this module's job is the pair of rules below: say which way
// it went, and never let the emoji cost the broadcast.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mdprem-"));

const test = require("node:test");
const assert = require("node:assert");

const sender = require("../src/massdm/sender");
const store = require("../src/massdm/store");

const EMO = (id) => ({ type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: id });
const job = (over = {}) => ({
  id: "j1",
  text: "gm 🔶 Dexvra",
  entities: [EMO("1"), EMO("2"), { type: "bold", offset: 3, length: 6 }],
  mediaPath: null,
  mediaFileId: null,
  mediaType: "photo",
  targets: [1, 2, 3],
  total: 3,
  sent: 0,
  failed: 0,
  cursor: 0,
  ref: "MD-1",
  reportChatId: 99,
  createdBy: null,
  // ⚠️ LAST, and its absence is what the first cut of this file got wrong: the
  // helper took an `over` argument and never spread it, so every test that
  // customised a job silently asserted against the DEFAULT one — and the
  // emoji-free case reported a premium verdict it could not have produced. A
  // test measuring its own fake, which is why the two that used it failed.
  ...over,
});

/**
 * A Telegram that behaves one of the three ways a real one can.
 *  "premium"  — accepts the entities and echoes them (the owner has Premium)
 *  "stripped" — accepts the message, echoes it WITHOUT the custom emoji
 *  "refused"  — rejects any message carrying them
 *  "blocked"  — every recipient has blocked the bot (the ordinary failure)
 *  "broken"   — every send fails for a reason that is NOT the user's doing
 */
function tg(mode) {
  const sent = [];
  const reports = [];
  const receipts = [];
  const reply = (extra, chat) => {
    const ents = extra.entities || extra.caption_entities || [];
    const custom = ents.filter((e) => e.type === "custom_emoji");
    if (custom.length && mode === "refused") throw new Error("400: Bad Request: CUSTOM_EMOJI_INVALID");
    // "mixed" is the ordinary shape of a real broadcast and the one the report
    // was modelled on: most land, one recipient has blocked the bot.
    if (mode === "blocked" || (mode === "mixed" && chat === 1)) {
      throw new Error("403: Forbidden: bot was blocked by the user");
    }
    if (mode === "broken") throw new Error("400: Bad Request: message caption is too long");
    return { message_id: sent.length, entities: mode === "stripped" ? ents.filter((e) => e.type !== "custom_emoji") : ents };
  };
  return {
    sent,
    reports,
    receipts,
    sendMessage: async (chat, text, extra = {}) => {
      if (chat === 99) {
        reports.push(text);
        return { message_id: 0 };
      }
      // The BUYER's own confirmation, captured apart from the audience — it is
      // a different message with different rules, and a job whose recipients
      // all fail must still be able to deliver it.
      if (chat === 77) {
        receipts.push(text);
        return { message_id: 0 };
      }
      sent.push({ chat, extra });
      return reply(extra, chat);
    },
    sendPhoto: async (chat, media, extra = {}) => {
      sent.push({ chat, extra, photo: true });
      const m = reply(extra, chat);
      return { ...m, photo: [{ file_id: "F1" }] };
    },
  };
}

// The premium verdict's ONE reader is a pm2 WARN now that the delivery report
// no longer carries it, so every driven test captures the log as well as the
// report — a rule whose only surface is a log line is a rule a test must read
// from that line.
const log = require("../src/helpers/logger");

async function run(mode, over) {
  const j = job(over);
  const t = tg(mode);
  const real = store.saveJob;
  const realWarn = log.warn;
  const warns = [];
  store.saveJob = async () => {};
  log.warn = (m) => warns.push(String(m));
  try {
    await sender.runJob(t, j);
  } finally {
    store.saveJob = real;
    log.warn = realWarn;
  }
  return { job: j, tg: t, report: t.reports.join("\n"), receipt: t.receipts.join("\n"), warns: warns.join("\n") };
}

// ── the verdict is Telegram's, and it is recorded ───────────────────────────

test("⚠️ a bot whose owner HAS Premium: the emoji go out untouched", async () => {
  const { job: j, tg: t, report, warns } = await run("premium");
  assert.strictEqual(j.sent, 3, "everyone was reached");
  assert.strictEqual(j.failed, 0);
  const wire = t.sent[0].extra;
  assert.strictEqual(wire.parse_mode, undefined, "entities are sent as entities, never re-parsed");
  assert.strictEqual(sender._customCount(wire.entities), 2, "both custom emoji reached the wire");
  assert.strictEqual(j.premiumOut, true);
  assert.ok(!/premium|emoji/i.test(warns), "the ordinary state is not worth a line per broadcast");
  assert.ok(!/[Ee]moji/.test(report), "the operator asked for this text gone");
});

// ⚠️ A DOWNGRADE MAY NOT BE SILENT — to anyone without Telegram Premium a plain
// send and an animated one are identical, which is the whole reason something
// has to say which. With the report line removed on the operator's call, pm2 is
// that something: recording the verdict and publishing it NOWHERE would be "a
// value nobody can read is the same as no value", committed by the change that
// removed the line.
test("⚠️ a bot whose owner does NOT: Telegram strips them, and pm2 says so", async () => {
  const { job: j, report, warns } = await run("stripped");
  assert.strictEqual(j.sent, 3, "the message still goes out — a downgrade, not a failure");
  assert.strictEqual(j.premiumOut, false);
  assert.match(warns, /STRIPPED the custom emoji/);
  assert.match(warns, /OWNER account needs Telegram Premium/, "the line names what is missing");
  assert.match(warns, /userbot's Premium covers the channel, not a DM/, "…and which account it is NOT");
  assert.ok(!/[Ee]moji/.test(report), "the delivery report stays out of it");
});

// ⚠️ The one that costs money: 12,000 sends failing identically over an entity.
test("⚠️ a REFUSAL never costs the broadcast — it is resent plain", async () => {
  // More targets than BROADCAST_CONCURRENCY, deliberately: the batches after
  // the first are what prove the strip was JOB-WIDE rather than per-recipient.
  const { BROADCAST_CONCURRENCY: CONC } = require("../src/config/constants");
  const targets = Array.from({ length: CONC * 3 }, (_, i) => i + 1);
  const { job: j, tg: t, report, warns } = await run("refused", { targets, total: targets.length });
  assert.strictEqual(j.sent, targets.length, "everyone was still reached");
  assert.strictEqual(j.failed, 0, "a paid broadcast may not reach nobody over an emoji");
  assert.strictEqual(sender._customCount(j.entities), 0, "stripped job-wide, not per recipient");
  assert.ok(
    j.entities.some((e) => e.type === "bold"),
    "⚠️ ONLY the custom emoji go — the bold runs and links are not collateral",
  );
  assert.strictEqual(j.premiumOut, false);
  assert.match(warns, /REFUSED the custom emoji/, "a fallback that fires silently reads as one that never fires");
  assert.ok(!/[Ee]moji/.test(report), "…and it still does not reach the delivery report");
  // The FIRST batch is already in flight when the first refusal lands, so up to
  // CONC of them pay a wasted attempt. Every batch after it costs nothing —
  // which is the whole difference between a job-wide strip and a per-send one.
  assert.ok(
    t.sent.length <= targets.length + CONC,
    `only the first batch may retry — ${t.sent.length} sends for ${targets.length} targets`,
  );
});

test("…and a job with no custom emoji takes no verdict at all", async () => {
  const { job: j, report, warns } = await run("premium", { entities: [{ type: "bold", offset: 0, length: 2 }] });
  assert.strictEqual(j.premiumOut, undefined, "a verdict on nothing is noise");
  assert.ok(!/[Ee]moji/.test(warns + report));
});

test("the verdict is read once, from the FIRST send", async () => {
  // It is a property of the BOT, not of the recipient: 12,000 identical
  // readings are one reading, and re-deciding per send would let a late
  // failure overwrite a true answer.
  const j = job();
  sender._notePremium(j, { entities: [EMO("1"), EMO("2")] });
  assert.strictEqual(j.premiumOut, true);
  sender._notePremium(j, { entities: [] }); // a later message with none
  assert.strictEqual(j.premiumOut, true, "the first answer stands");
});

// ⚠️ What the echo CANNOT say. Telegram accepting the entity is not the same as
// a given reader seeing it animated — that is their own Premium, client-side.
// Claiming it would be a fact nobody measured.
test("⚠️ the media path records it too — a photo job's first send is primeMedia", async () => {
  // ⚠️ ONE TARGET, and that is the whole point of the fixture. primeMedia sends
  // the first recipient itself and the batch loop starts at the cursor it left,
  // so on a wider job sendOne records the verdict anyway and removing
  // primeMedia's own call changes nothing — a mutation run said exactly that.
  // A single-recipient media job (an admin test run reaches one inbox) is the
  // shape where that call is the ONLY one, so it is the shape that proves it.
  const { job: j, warns } = await run("stripped", { mediaPath: "/tmp/x.png", targets: [7], total: 1 });
  assert.strictEqual(j.sent, 1, "primeMedia is the only send this job makes");
  assert.strictEqual(j.premiumOut, false, "the caption's entities are judged the same way");
  assert.match(warns, /STRIPPED the custom emoji/);
});

// ── the BUYER's receipt ─────────────────────────────────────────────────────
//
// "this work tapi jgn sebut number, blg aja to all user dexvra dan berapa
// banyak yang gagal kaya fourtis" — the receipt used to read
// `Ref … · reached 263 users`, three words of arithmetic the buyer did not ask
// for and one number that says nothing about whether the run was healthy. It
// carries the same two lines the ops report does now, because they answer the
// same question; what differs is the noun and the emphasis, not the rule.

const BUYER = { createdBy: 77 };

test("⚠️ the receipt says it went to all Dexvra users, and never a reached count", async () => {
  const { job: j, receipt } = await run("mixed", BUYER);
  assert.strictEqual(j.sent, 2, "the fixture must really have one blocked recipient");
  assert.strictEqual(j.failed, 1);
  assert.ok(receipt, "the buyer is told at all");
  assert.match(receipt, /📬 Sent to all Dexvra users/);
  assert.match(receipt, /🚫 Couldn't reach \(blocked\/inactive\): 1/);
  assert.ok(!/reached/i.test(receipt), `the count the ask was about: ${JSON.stringify(receipt)}`);
  assert.ok(!/\b2\b/.test(receipt), "…and not by another spelling either");
});

// ⚠️ The receipt is the MARKUP surface, not HTML — `parse_mode: HTML` belongs to
// the ops report alone. An `<b>` handed to a template var reaches the buyer as
// literal text, which is what a single shared bold wrapper would have done.
test("⚠️ …and no HTML tag ever reaches it", async () => {
  const { receipt } = await run("mixed", BUYER);
  assert.ok(!/<\/?[a-z]/i.test(receipt), receipt);
  assert.ok(!/\*\*/.test(receipt), "the markup is parsed into entities, never shown");
});

// ⚠️ The CLAIM rule is the one owner's whole reason for existing, and this is
// where a second copy would show: a receipt with its own "Sent to all Dexvra
// users" line would congratulate a buyer whose broadcast reached nobody.
test("⚠️ a run that reached NOBODY says so to the buyer too", async () => {
  const { job: j, receipt, report } = await run("blocked", BUYER);
  assert.strictEqual(j.sent, 0);
  assert.ok(!/Sent to all/.test(receipt), "the tick over a broken thing");
  assert.match(receipt, /📭 Delivered to nobody/);
  assert.match(report, /📭 <b>Delivered to nobody<\/b>/, "…the two surfaces agree, because they share the line");
});

test("a clean run tells the buyer nothing about failures", async () => {
  const { receipt } = await run("premium", BUYER);
  assert.match(receipt, /📬 Sent to all Dexvra users/);
  assert.ok(!/Couldn't reach/.test(receipt), "a line saying 0 is noise");
});

// ⚠️ WHICH upstream call failed is an OPERATOR's question. It is also the one
// value on these lines that is not a number, so it is the one that would have
// to be escaped — and the two surfaces escape differently.
test("⚠️ the upstream error text is ops-only", async () => {
  const { report, receipt } = await run("broken", BUYER);
  assert.match(report, /caption is too long/, "the operator is told what to act on");
  assert.ok(!/caption is too long/.test(receipt), "the buyer is not");
});

// ⚠️ `data/templates.json` WINS OVER THE CODE DEFAULT FOR EVER, so an operator
// who has edited this card keeps their own `reached **{reached}** users` line —
// and `substitute()` renders an unknown placeholder as EMPTY, so dropping the
// var would turn it into "reached **** users": worse than the number the ask
// was about. They get the new shape by tapping ♻️ Reset default.
test("⚠️ an operator's SAVED copy still resolves its old count", async (t) => {
  const tpl = require("../src/templates");
  const OLD = "Ref `{ref}` · reached **{reached}** users.";
  const orig = tpl.render;
  t.after(() => (tpl.render = orig));
  // substitute()'s own rule: a placeholder with no var becomes "".
  tpl.render = (key, vars) => ({
    text: OLD.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : "")),
  });
  const { receipt } = await run("mixed", BUYER);
  assert.match(receipt, /reached \*\*2\*\* users/, `a blank here is a card that lost its number: ${receipt}`);
});

// The state no completed run can reach, so it is asserted on the owner itself:
// `runJob` always walks to the end of its targets, and a job that stops short
// is a crashed process resumed later.
test("⚠️ …nor over a run that stopped short, on either surface", () => {
  const short = { id: "j", total: 12528, sent: 40, failed: 2, unreachable: 2 };
  const buyer = sender._reachLine(short, { who: "Dexvra users" });
  assert.ok(!/Sent to all/.test(buyer));
  assert.match(buyer, /Sent to 40 of 12528 — the run did not finish/);
  assert.ok(!/Sent to all/.test(sender._reportText(short)));
});

// ── the delivery report ─────────────────────────────────────────────────────
//
// "laporanya seperti fourtis aja" — the ref, what paid for it, one line saying
// it went out, one naming what could not be reached. The shape is copied; every
// line in it is MEASURED, which is where these tests live.

const rpt = (over) =>
  sender._reportText({ id: "j", ref: "pbc_mtwzg9m7_sia7fv", total: 12528, sent: 12110, failed: 418, unreachable: 418, ...over });

test("the report reads like the reference bot's", () => {
  const t = rpt({ paid: "included with listing package" });
  assert.match(t, /📣 <b>Broadcast delivered<\/b>/);
  assert.match(t, /<b>Ref:<\/b> <code>pbc_mtwzg9m7_sia7fv<\/code>/);
  assert.match(t, /<b>Paid:<\/b> included with listing package/);
  assert.match(t, /📬 <b>Sent to all users<\/b>/);
  assert.match(t, /🚫 <b>Couldn't reach \(blocked\/inactive\):<\/b> 418/);
});

// ⚠️ "hapus teks premium emoji" — and a removal has to be pinned, or it comes
// back the first time somebody reaches for the verdict the job still carries.
// The report may say NOTHING about the emoji in ANY of the three states: it
// never changes between runs (it is a property of the bot), so a line repeating
// it on every broadcast is the noise this was asked to end. Where it DOES have
// to be said is pm2, and the driven tests above read it from there.
test("⚠️ the delivery report says nothing about premium emoji, in any state", () => {
  for (const over of [{ premiumOut: true }, { premiumOut: false, premiumWhy: "Telegram STRIPPED them" }, {}]) {
    const t = rpt(over);
    assert.ok(!/[Ee]moji/.test(t), `the report may not mention them (${JSON.stringify(over)})`);
    assert.ok(!/PLAIN|animated/.test(t));
    assert.match(t, /📬 <b>Sent to all users<\/b>/, "…and the rest of the report is untouched");
  }
});

// ⚠️ "Sent to all users" is a CLAIM. These two states are the ones where
// copying the reference's line verbatim would print a falsehood.
test("⚠️ …but it never claims 'all users' over a run that reached nobody", () => {
  const t = rpt({ sent: 0, failed: 12528, unreachable: 12528 });
  assert.ok(!/Sent to all users/.test(t), "every send failed — saying it went out is the tick over a broken thing");
  assert.match(t, /📭 <b>Delivered to nobody<\/b>/);
});

test("⚠️ …nor over a run that stopped short", () => {
  // sent + failed < total: the loop did not get through the audience.
  const t = rpt({ sent: 40, failed: 2, unreachable: 2 });
  assert.ok(!/Sent to all users/.test(t));
  assert.match(t, /Sent to 40 of 12528<\/b> — the run did not finish/);
});

// ⚠️ The half an operator can act on. Laundering every failure as
// "blocked/inactive" would be a cause nobody measured.
test("⚠️ a failure OUTSIDE the blocked family is counted apart and NAMED", () => {
  const t = rpt({ failed: 428, unreachable: 418, otherFails: 10, otherWhy: "Bad Request: message is too long" });
  assert.ok(!/\(blocked\/inactive\)/.test(t), "the parenthetical asserts ALL of them — it may not stand here");
  assert.match(t, /418 blocked\/inactive, <b>10 for another reason<\/b>/);
  assert.match(t, /message is too long/);
});

test("…and a clean run prints no failure line at all", () => {
  const t = rpt({ sent: 12528, failed: 0, unreachable: 0 });
  assert.ok(!/Couldn't reach/.test(t), "a line saying 0 is noise");
  assert.match(t, /📬 <b>Sent to all users<\/b>/);
});

test("the Paid line tells the three products apart", () => {
  assert.match(rpt({ paid: "included with listing package" }), /<b>Paid:<\/b> included with listing package/);
  assert.match(rpt({ paid: "2 SOL" }), /<b>Paid:<\/b> 2 SOL/);
  assert.match(rpt({ test: true, paid: "2 SOL" }), /<b>Paid:<\/b> free admin test/);
  assert.match(rpt({}), /<b>Paid:<\/b> paid broadcast/, "an older job with no field still says something true");
});

// ⚠️ parse_mode is HTML and Telegram's own error text is not ours. One stray
// `<` makes it reject the whole report with a 400 — so the one line that
// explains a failure would be the line that vanishes.
test("⚠️ Telegram's error text is escaped before it goes back to Telegram", () => {
  const t = rpt({ failed: 2, unreachable: 1, otherFails: 1, otherWhy: "Bad Request: <b>nope</b> & co" });
  assert.ok(!/<b>nope<\/b>/.test(t), "a raw tag out of an upstream error is a 400 on the report");
  assert.match(t, /&lt;b&gt;nope&lt;\/b&gt; &amp; co/);
});

test("⚠️ the cause is CLASSIFIED from Telegram's own sentence, not assumed", () => {
  const j = {};
  for (const why of [
    "Forbidden: bot was blocked by the user",
    "Forbidden: user is deactivated",
    "Bad Request: chat not found",
    "Bad Request: PEER_ID_INVALID",
  ]) sender._noteFailure(j, new Error(why));
  assert.strictEqual(j.unreachable, 4, "the ordinary family — not a fault");
  assert.strictEqual(j.otherFails, undefined);

  sender._noteFailure(j, new Error("Bad Request: message caption is too long"));
  assert.strictEqual(j.otherFails, 1, "anything else is the operator's to see");
  assert.match(j.otherWhy, /caption is too long/);
  sender._noteFailure(j, new Error("Something else entirely"));
  assert.strictEqual(j.otherFails, 2);
  assert.match(j.otherWhy, /caption is too long/, "the FIRST reason is kept — a later one does not overwrite it");
});

// ⚠️ A POSITIVE, DRIVEN test, because every report test above builds its job by
// hand: with `noteFailure` deleted from sendOne outright, all of them stayed
// green and the report would have gone back to a bare count. A mutation run
// said so — the "a wiring that does nothing refuses beautifully" scar, on the
// one line an operator reads to decide whether to worry.
test("⚠️ the sender really classifies what Telegram told it — driven", async () => {
  const { job: j, report } = await run("blocked");
  assert.strictEqual(j.sent, 0);
  assert.strictEqual(j.failed, 3);
  assert.strictEqual(j.unreachable, 3, "the sender, not the test, put this on the job");
  assert.strictEqual(j.otherFails, undefined);
  assert.match(report, /🚫 <b>Couldn't reach \(blocked\/inactive\):<\/b> 3/);
  assert.match(report, /📭 <b>Delivered to nobody<\/b>/, "…and it does not claim it went out");
});

test("⚠️ …and a failure that is NOT the user's doing reaches the report as one", async () => {
  const { job: j, report } = await run("broken");
  assert.strictEqual(j.unreachable, undefined, "nothing here was a blocked recipient");
  assert.strictEqual(j.otherFails, 3);
  assert.ok(!/\(blocked\/inactive\)/.test(report), "this is the operator's problem, not the audience's");
  assert.match(report, /<b>3 for another reason<\/b>/);
  assert.match(report, /caption is too long/);
});
