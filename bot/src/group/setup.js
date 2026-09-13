// Group buy-bot setup commands (run inside a project's group chat, by a group
// admin): /settoken, /setchain, /setminbuy, /buybot on|off, /buybot (status).
// A project adds @dexvrabot to their group and points it at their token.
const { Markup } = require("telegraf");
const cfg = require("./config");
const gt = require("./gtPairs");
const chainPools = require("./chainPools");
const holdings = require("./walletHoldings");
const { CHAIN_IDS, chainOf } = require("../config/chains");
const whaleCfg = require("../services/whaleConfig");
const tpl = require("../templates");
const premium = require("../premium");
const { payloadArgs } = require("../helpers/message");
const log = require("../helpers/logger");

/**
 * Reply with an admin-editable template.
 *
 * Every user-facing string in this file goes through here. They used to be HTML
 * literals, which meant the copy a paying project reads while wiring the bot up
 * — the whole first-run experience — was the one part of the bot an operator
 * could not touch without a deploy.
 *
 * Always .catch(): a group that removed the bot mid-command must not throw.
 */
function say(ctx, key, vars, opts) {
  const { text, extra } = payloadArgs(tpl.render(key, vars, opts), false);
  return ctx.reply(text, { ...extra, disable_web_page_preview: true }).catch(() => {});
}

// Only a group admin/creator may configure the buy bot.
async function isGroupAdmin(ctx) {
  try {
    if (ctx.chat.type === "private") return true; // solo testing
    const m = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return m && (m.status === "administrator" || m.status === "creator");
  } catch {
    return false;
  }
}

const isGroup = (ctx) => ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup");
const arg = (ctx) => (ctx.message.text || "").split(/\s+/).slice(1).join(" ").trim();

// Candidate chains to probe for a pasted address, by shape. Ordered so the most
// likely wins first; the FIRST chain with a live pool is chosen.
function candidateChains(address) {
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return ["ethereum", "bsc", "base", "robinhood", "plasma"];
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return ["tron"];
  if (/^(EQ|UQ|0:)/.test(address)) return ["ton"];
  if (/^0x[a-fA-F0-9]+::/.test(address)) return ["sui"];
  return ["solana"]; // base58 mint
}

/** Probe candidate chains for a live pool; return {chain, pool} or null. */
async function resolveToken(address) {
  const candidates = candidateChains(address);

  // ⚠️ ONE REQUEST ANSWERS EVERY CANDIDATE CHAIN, and not asking it this way is
  // what made a Robinhood contract resolve as "Ethereum".
  //
  // Reported 2026-09-12: an 0x… Robinhood token pasted into Mass DM came back
  // "We couldn't confirm this token's chain … it looks like Ethereum". Two
  // causes, both here. `gtPairs` carried a PRIVATE seven-entry copy of the
  // DexScreener chain map with no robinhood in it, so DexScreener was never
  // asked about that chain at all (fixed at its own definition — one owner);
  // and the loop below is SERIAL over five candidates with robinhood FOURTH,
  // each one able to fall through to the GeckoTerminal queue, which has no
  // deadline of its own. Under CA_RESOLVE_MS it never reached candidate 4.
  //
  // DexScreener's token endpoint returns the pairs on EVERY chain in one
  // answer, and this file was making five identical requests to it and
  // discarding four fifths of each. One request, no queue, and the chain is
  // picked by POOL DEPTH rather than by the candidate list's order.
  const across = await gt.dsResolveAcross(address, candidates).catch(() => null);
  if (across && across.pool && across.pool.poolAddress) return across;

  // Then per chain, for the tokens that endpoint does not carry. Serial and in
  // candidate order: a bounded caller may not reach the end of it, which is the
  // whole reason the single request above runs first.
  for (const chain of candidates) {
    const pool = await gt.fetchPool(chain, address).catch(() => null);
    if (pool && pool.poolAddress) return { chain, pool };
  }
  // Then the chain itself. An indexer's coverage is a business decision about
  // which tokens are worth indexing, taken by somebody else, about our
  // customers — and a pool with $400 in it on a young chain does not survive
  // that decision. It is still a real pool with real buys, and the group was
  // being told "No live pool on that CA" about a pool that plainly exists.
  //
  // Second pass rather than per-chain, so the cheap probe covers ALL five
  // chains before any expensive one runs: a token the indexer knows never pays
  // for a log sweep.
  for (const chain of candidates) {
    if (!chainPools.supports(chain)) continue;
    const found = await chainPools.findPool(chain, address).catch(() => null);
    if (found && found.poolAddress) return { chain, pool: found };
  }
  return null;
}

// ⚠️ A DEADLINE FOR THE CALLERS WHO HAVE SOMEBODY WAITING.
//
// Reported 2026-09-12: a Mass DM buyer pasted an 0x… address, the bot replied
// "🔍 Detecting your token's chain…" and never said another word.
//
// Nothing had crashed. resolveToken is SERIAL and an 0x… address has FIVE
// candidate chains, so it is up to five gt.fetchPool calls — each queued on
// gtSlot(PRIO_BACKGROUND), which has NO DEADLINE OF ITS OWN — and then up to
// five chainPools log sweeps behind them. On the keyless budget, behind nine
// background pipelines, a user-prompted paste sits in the background tier for
// minutes. From Telegram that is a dead bot, and it was reported as one.
//
// This is the LISTING FORM's defect, verbatim, in the two flows that never got
// its fix ("bot tidak merespon untuk paket listing setelah di minta drop ca" —
// bounded at LISTING_AUTOFILL_MS for exactly this reason). A lesson applied to
// one flow is a lesson half-learnt, so the deadline lives HERE, once, rather
// than at each caller: a rule the second caller has to remember is one the
// third forgets.
//
// The background callers keep their queue semantics untouched — only the
// people who are waiting stop waiting on them.
//
// ⚠️ IT RETURNS WHICH SILENCE IT WAS. "We could not ask in time" and "no live
// pool exists on any chain we support" are different facts and the two flows
// owe the user different sentences: one is about us, the other is about their
// token. Collapsing them into a bare null is how a timeout gets rendered as a
// fact about somebody's contract.
const CA_RESOLVE_MS = Math.max(1000, Number(process.env.CA_RESOLVE_MS || 8000));

function resolveTokenSoon(address, ms = CA_RESOLVE_MS) {
  // ⚠️ THE TIMER IS NOT unref'd — somebody is awaiting this, and an unref'd
  // timer does not hold the event loop open, so a process with nothing else
  // pending exits with the flow hung for ever. Cleared on the winning path, or
  // an 8s budget keeps the loop alive for 8s after a 200ms answer. The scar is
  // in helpers/bounded.js and in tradebot's own bounded(); this is the third
  // time it has had to be written down.
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ res: null, timedOut: true }), ms);
    Promise.resolve()
      .then(() => resolveToken(address))
      .then(
        (res) => { clearTimeout(t); resolve({ res: res || null, timedOut: false }); },
        () => { clearTimeout(t); resolve({ res: null, timedOut: false }); },
      );
  });
}

const usd$ = (n) => "$" + Number(n).toLocaleString("en-US");

// chatId → the outstanding "paste your contract address" prompt: the message it
// is waiting on a reply to, and who asked for it. In memory only — a prompt
// nobody answered before a restart is re-opened by running /settoken again,
// which is one tap, and persisting it would mean a stale prompt swallowing an
// unrelated reply days later.
const pendingToken = new Map();

/**
 * Ask for the contract address with force_reply, so the group member's keyboard
 * opens already pointed at this prompt.
 *
 * selective + a reply to their own command aims the forced reply at the admin
 * who ran it. Without that, every member of the group gets an input box shoved
 * in front of them by a setting that is not theirs to change.
 */
/**
 * The project's website / X / Telegram, for the /settoken receipt.
 *
 * Purely decorative, so every failure resolves to empty rows rather than
 * propagating: the token is configured and the alerts are running by the time
 * this is called, and an indexer having a bad minute must not turn a successful
 * setup into an error message. Bounded by its own timeout for the same reason.
 *
 * Returns the prebuilt {links} row AND the three parts separately, so an
 * operator who rewrites the template can lay them out differently.
 */
const LINKS_TIMEOUT_MS = 4000;
async function tokenLinks(chain, address) {
  const empty = { links: "", website: "", twitter: "", telegram: "" };
  let info = null;
  try {
    info = await Promise.race([
      require("../dexscreener").fetchTokenInfo(chain, address),
      new Promise((r) => setTimeout(() => r(null), LINKS_TIMEOUT_MS)),
    ]);
  } catch (_) {
    return empty;
  }
  if (!info) return empty;
  // Each URL goes through the same sanitiser the alert cards use. These come
  // from a third-party feed and land inside an href in a group message: a
  // javascript: URL has no business there, and a malformed one makes Telegram
  // reject the WHOLE message, which would take the receipt down over a link.
  const one = (url, label, icon) => {
    const safe = url ? premium.sanitizeUrl(url) : "";
    if (!safe || !/^https?:\/\//i.test(safe)) return "";
    // The icon is optional: an operator who empties one in `social_emojis`
    // means "no glyph on this one", not "a leading space".
    return icon ? `${icon} [${label}](${safe})` : `[${label}](${safe})`;
  };
  // Icons and wording from their templates, not from literals here — these were
  // the only three glyphs on this row the emoji editor could not reach.
  // Field-by-field fallback, the same rule as every other pipe template: a
  // half-typed override still renders a row instead of blanks.
  const icons = require("../channels/format").emojiMapTemplate("social_emojis");
  const words = String(tpl.t("social_labels") || "").split("|");
  const word = (i, def) => (words[i] || "").trim() || def;
  const website = one(info.website, word(0, "Website"), icons.website);
  const twitter = one(info.twitter, word(1, "X"), icons.x);
  const telegram = one(info.telegram, word(2, "Telegram"), icons.telegram);
  const found = [website, twitter, telegram].filter(Boolean);
  return {
    // The WHOLE row, so it collapses cleanly on a token with no socials — which
    // is most fresh launches. A bare "Links:" with nothing after it is not a
    // row, it is a rendering bug.
    links: found.length ? found.join(" · ") : "",
    website,
    twitter,
    telegram,
  };
}

/**
 * tokenLinks, memoised — because /ca is asked by MEMBERS, not once by an admin.
 *
 * /settoken calls tokenLinks exactly once per setup, so it never needed this.
 * /ca is the opposite: a busy group asks it dozens of times a day, and every
 * one of those would be a fresh DexScreener request for socials that change
 * about never. That is a self-inflicted rate limit, and this project has
 * already had one third-party feed refuse this server at the IP level.
 *
 * A FAILURE IS CACHED TOO, briefly. An indexer having a bad minute must not be
 * re-asked on every single /ca for that minute — and the empty answer is
 * harmless, because the socials row simply collapses.
 */
const LINKS_TTL_MS = 10 * 60 * 1000;
const LINKS_FAIL_TTL_MS = 60 * 1000;
const linksCache = new Map(); // `${chain}:${address}` → { at, ttl, value }

async function cachedTokenLinks(chain, address) {
  const k = `${chain}:${address}`;
  const hit = linksCache.get(k);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = await tokenLinks(chain, address);
  linksCache.set(k, { at: Date.now(), ttl: value.links ? LINKS_TTL_MS : LINKS_FAIL_TTL_MS, value });
  return value;
}

async function promptForToken(ctx, replyTo) {
  const { text, extra } = payloadArgs(tpl.render("settoken_prompt"), false);
  const sent = await ctx
    .reply(text, {
      ...extra,
      disable_web_page_preview: true,
      reply_to_message_id: replyTo,
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: "Contract address" },
    })
    .catch(() => null);
  if (sent) pendingToken.set(String(ctx.chat.id), { messageId: sent.message_id, userId: ctx.from.id });
}

/**
 * A reply to the force_reply prompt above IS the contract address.
 *
 * Middleware, so anything that is not that reply falls through untouched: this
 * sits in front of the private-chat text router and sees every message in every
 * group the bot is in.
 */
/**
 * A message that is NOTHING BUT a contract address, on a chain we run on.
 *
 * Deliberately anchored to the whole message: a CA quoted inside a sentence is
 * someone talking about a token, not someone configuring the bot. Kept in step
 * with candidateChains — anything that shape cannot place has no chain to
 * resolve on either.
 */
function looksLikeAddress(s) {
  return (
    /^0x[a-fA-F0-9]{40}$/.test(s) || // EVM
    /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s) || // Tron
    /^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(s) || // TON
    /^0x[a-fA-F0-9]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/.test(s) || // Sui
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) // Solana mint
  );
}

async function groupTokenReply(ctx, next) {
  if (!isGroup(ctx)) return next();
  const body = String((ctx.message && ctx.message.text) || "").trim();
  const replyTo = ctx.message && ctx.message.reply_to_message;
  const pending = pendingToken.get(String(ctx.chat.id));
  const answering =
    replyTo && pending && replyTo.message_id === pending.messageId && ctx.from && ctx.from.id === pending.userId;
  if (answering) {
    pendingToken.delete(String(ctx.chat.id));
    const address = body.split(/\s+/)[0] || "";
    if (!address) return say(ctx, "settoken_not_found");
    return applyToken(ctx, address);
  }
  // "ca" on its own — the question this group asks all day, without the slash.
  // Only when a token IS set: see CA_WORD_RE. Checked before the address scan
  // because it is a cheap string test and cannot match an address.
  if (CA_WORD_RE.test(body)) {
    const gc = cfg.get(ctx.chat.id);
    if (gc && gc.address) return ca(ctx);
    return next();
  }
  // An admin dropping a bare contract address into the group is asking for the
  // buy bot, near enough — but it is ASKED, never assumed.
  //
  // This used to call applyToken() on the spot. That is how a group ends up
  // watching a token nobody chose: somebody pastes a CA to show it to a member,
  // and the bot reads a message that was never addressed to it as an
  // instruction. The admin then finds a contract configured they have no memory
  // of setting, which is exactly the report that produced this change.
  //
  // It also now fires when a token IS already set — the old code returned early
  // there, so pasting a new CA into a configured group did nothing at all and
  // looked like a dead bot. Replacing a live config is precisely the case that
  // must be confirmed rather than skipped, so the card says what it replaces.
  //
  // The admin lookup costs an API call, so it stays the LAST check.
  if (!looksLikeAddress(body)) return next();
  const g = cfg.get(ctx.chat.id);
  if (g && g.address && String(g.address).toLowerCase() === body.toLowerCase()) return next(); // already watching it
  if (!(await isGroupAdmin(ctx))) return next();
  return askActivate(ctx, body, g);
}

// chatId → the outstanding "activate this token?" card. In memory only, for the
// same reason pendingToken is: a stale confirmation surviving a restart could
// arm a contract somebody pasted days ago.
const pendingActivate = new Map();
const ACTIVATE_TTL_MS = 10 * 60 * 1000;
let activateSeq = 0;

/**
 * Offer to point the buy bot at a pasted address.
 *
 * The address travels in the MAP, not in the callback data: Telegram caps
 * callback_data at 64 bytes and a Sui type string ("0x…::coin::COIN") blows
 * straight past it — which would fail silently, on exactly the chains this bot
 * had to grow support for. The callback carries a sequence number instead, so a
 * card left open in history cannot arm whatever the group is discussing now.
 */
async function askActivate(ctx, address, g) {
  const id = ++activateSeq;
  pendingActivate.set(String(ctx.chat.id), { id, address, at: Date.now() });
  const who = ctx.from && ctx.from.username ? `@${ctx.from.username}` : "an admin";
  const current =
    g && g.address
      ? tpl.markup("buybot_activate_replaces", { symbol: premium.sanitizeVar(g.sym ? `$${String(g.sym).replace(/^\$/, "")}` : "the current token") })
      : "";
  const [yes, no] = String(tpl.t("buybot_activate_buttons") || "").split("|");
  const { text, extra } = payloadArgs(
    tpl.render("buybot_activate_ask", {
      address: premium.sanitizeVar(address),
      requester: premium.sanitizeVar(who),
      current,
    }),
    false,
  );
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(yes || "🤖 Activate buy bot", `bs_act:${id}`)],
    [Markup.button.callback(no || "❌ Cancel", `bs_actno:${id}`)],
  ]);
  await ctx.reply(text, { ...extra, disable_web_page_preview: true, ...kb }).catch(() => {});
}

/**
 * The confirm / cancel on that card.
 *
 * Re-checks ADMIN at tap time rather than trusting the card: an inline keyboard
 * is visible to every member of the group, and the tap is the moment the
 * contract actually changes.
 */
async function activateTap(ctx) {
  const m = /^bs_(act|actno):(\d+)$/.exec((ctx.callbackQuery && ctx.callbackQuery.data) || "");
  if (!m || !isGroup(ctx)) return;
  const [, what, id] = m;
  const pending = pendingActivate.get(String(ctx.chat.id));
  // Expired, superseded by a newer paste, or lost to a restart. Say so rather
  // than arming an address the group has moved on from.
  if (!pending || String(pending.id) !== id || Date.now() - pending.at > ACTIVATE_TTL_MS) {
    pendingActivate.delete(String(ctx.chat.id));
    return void ctx.answerCbQuery(tpl.t("buybot_activate_stale"), { show_alert: true }).catch(() => {});
  }
  if (!(await isGroupAdmin(ctx))) {
    return void ctx.answerCbQuery(tpl.t("setup_admin_only"), { show_alert: true }).catch(() => {});
  }
  pendingActivate.delete(String(ctx.chat.id));
  if (what === "actno") {
    await ctx.answerCbQuery(tpl.t("buybot_activate_cancelled")).catch(() => {});
    // The card goes with it: a cancelled question left on screen reads as one
    // still waiting for an answer.
    return void ctx.deleteMessage().catch(() => {});
  }
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {}); // no double-arming from a second tap
  return applyToken(ctx, pending.address);
}

async function settoken(ctx) {
  if (!isGroup(ctx)) return say(ctx, "setup_group_only");
  if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
  const address = arg(ctx);
  // A bare /settoken — the version Telegram's command menu sends — asks for the
  // address instead of printing syntax. One tap, then paste.
  if (!address) return promptForToken(ctx, ctx.message && ctx.message.message_id);
  return applyToken(ctx, address);
}

async function applyToken(ctx, address) {
  await say(ctx, "settoken_resolving");
  // ⚠️ BOUNDED, and the two silences get two answers: see resolveTokenSoon.
  // A lookup that ran out of time says nothing about the address, and telling
  // an admin "no live pool on that CA" about a token that has one sends them
  // off to check something that is not broken.
  const { res, timedOut } = await resolveTokenSoon(address);
  if (!res) return say(ctx, timedOut ? "settoken_resolve_slow" : "settoken_not_found");
  // One extra lookup, once, for the token's NAME — the pool listing only knows
  // the PAIR ("HOPPY / WETH"), and the name is what headlines every alert.
  const info = await gt.fetchTokenInfo(res.chain, address).catch(() => null);
  // …and when the indexer has never heard of the token — which is exactly the
  // case a chain-found pool describes — the token contract itself is asked.
  // Without this every alert headlines the "$TOKEN" placeholder, because
  // nothing else in the bot ever learns a group's ticker.
  const meta = info && info.symbol ? null : await chainPools.tokenMeta(res.chain, address).catch(() => null);
  const sym = (info && info.symbol) || res.pool.symbol || (meta && meta.symbol) || "";
  const name = (info && info.name) || res.pool.name || (meta && meta.name) || "";
  await cfg.upsert(ctx.chat.id, {
    chain: res.chain,
    address,
    pairAddress: res.pool.poolAddress,
    // Without these every alert reads "$TOKEN" — the placeholder the renderer
    // falls back to. Nothing else in the bot ever learns a group's ticker.
    sym,
    name,
    on: true,
  });
  // Everything the bot needs is now set — the floor, the whale bar and the
  // on-switch all have working defaults — so the confirmation reports what is
  // ALREADY running and offers one button to change it, instead of handing back
  // a row of commands to go and run.
  const g = cfg.get(ctx.chat.id) || {};
  // The project's own links, best-effort. NEVER awaited on the critical path
  // for longer than it takes to give up: the token is already configured and
  // the alerts are already live by this point, so a slow or dead indexer must
  // cost a row on a receipt, never the receipt itself.
  const links = await tokenLinks(res.chain, address);
  const safeName = premium.sanitizeVar(name || "your token");
  const safeSym = premium.sanitizeVar(sym ? `$${String(sym).replace(/^\$/, "")}` : "");
  const { text, extra } = payloadArgs(
    tpl.render("settoken_ok", {
      chain: chainOf(res.chain).label,
      // The network's own mark, from the same admin-editable `chain_emojis`
      // map the buy cards read — so setting a premium Solana emoji once lights
      // it up here, on the alert cards and in the channel posts together.
      chainEmoji: require("../channels/format").chainEmoji(res.chain),
      // The token's own name and ticker come from a third-party feed, so they go
      // through the same sanitiser the alert cards use — a token literally named
      // "[click](url)" would otherwise inject a link into the group's setup reply.
      name: safeName,
      symbol: safeSym,
      // Prebuilt, so a token with no name resolved prints just the ticker
      // instead of "your token $ALON" — same rule as the buy cards' 📃 row.
      nameRow: name ? `📃 **${safeName}** ${safeSym}` : `📃 **${safeSym || "your token"}**`,
      address,
      ...links,
      minBuy: usd$(cfg.minBuyOf(g)),
      whale: usd$(g.whaleWalletUsd || whaleCfg.get().walletUsd),
    }),
    false,
  );
  const kb = Markup.inlineKeyboard([[Markup.button.callback("⚙️ Settings", "bs_home")]]);
  await ctx.reply(text, { ...extra, disable_web_page_preview: true, ...kb }).catch(() => {});
  log.info(`[group] ${ctx.chat.id} set token ${res.chain}/${address} pool ${res.pool.poolAddress}`);
}

async function setchain(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
  const chain = arg(ctx).toLowerCase();
  if (!CHAIN_IDS.includes(chain)) return say(ctx, "setchain_unknown", { chains: CHAIN_IDS.join(", ") });
  const g = cfg.get(ctx.chat.id);
  if (!g || !g.address) return say(ctx, "setchain_need_token");
  // re-resolve the pool on the NEW chain (used to leave a stale wrong-chain pair)
  const pool = await gt.fetchPool(chain, g.address).catch(() => null);
  await cfg.upsert(ctx.chat.id, { chain, pairAddress: pool ? pool.poolAddress : null });
  await say(ctx, pool ? "setchain_ok" : "setchain_ok_nopool", { chain: chainOf(chain).label });
}

// Preset floors for the /setminbuy picker. Round numbers a project actually
// chooses — the point is that this setting costs one tap, not a decision about
// which number to type into a command.
//
// It starts at the $10 minimum, not at "every buy": a chat of $0.40 alerts
// reads as a dead token, and the project wearing that is the one paying for the
// bot. See cfg.MIN_BUY_FLOOR_USD.
const MIN_BUY_PRESETS = [cfg.MIN_BUY_FLOOR_USD, 25, 50, 100, 250, 500, 1000, 5000];

/** The picker's keyboard, with a ✓ on whatever the group is currently set to. */
function minBuyKeyboard(current) {
  const btn = (n) => Markup.button.callback(usd$(n) + (Number(current) === n ? " ✓" : ""), `mb_${n}`);
  const rows = [];
  for (let i = 0; i < MIN_BUY_PRESETS.length; i += 3) rows.push(MIN_BUY_PRESETS.slice(i, i + 3).map(btn));
  return Markup.inlineKeyboard(rows);
}

/** Picker text + keyboard for THIS group's current floor. Built in one place so
 *  the first send and every in-place refresh after a tap cannot drift apart. */
function minBuyPanel(chatId) {
  const current = cfg.minBuyOf(cfg.get(chatId));
  const { text, extra } = payloadArgs(tpl.render("setminbuy_panel", { usd: usd$(current) }), false);
  return { text, extra: { ...extra, disable_web_page_preview: true, ...minBuyKeyboard(current) } };
}

async function setminbuy(ctx) {
  if (!isGroup(ctx)) return say(ctx, "setup_group_only");
  if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
  const raw = arg(ctx).replace(/[$,_]/g, "");
  // A bare /setminbuy opens the picker. It used to fall straight through to
  // Number("") — which is 0, and finite, and >= 0 — so tapping the command in
  // Telegram's menu silently set the floor to $0 and answered "Floor set". A
  // command with no argument is a question, not an instruction.
  if (!raw) {
    const p = minBuyPanel(ctx.chat.id);
    return ctx.reply(p.text, p.extra).catch(() => {});
  }
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) return say(ctx, "setminbuy_usage");
  // Below the floor is not an error — it is someone asking for every buy. They
  // get the floor and a line saying so, rather than a refusal to act.
  const floored = Math.max(usd, cfg.MIN_BUY_FLOOR_USD);
  await cfg.upsert(ctx.chat.id, { minBuyUsd: floored });
  await say(ctx, usd < floored ? "setminbuy_min" : "setminbuy_ok", { usd: usd$(floored) });
}

/**
 * Every button in this file guards the same way.
 *
 * The panels live in a GROUP chat, where any member can reach the buttons long
 * after an admin opened them. The check on the command only covers who opened
 * it, so it has to be repeated on each tap.
 */
async function tapAllowed(ctx) {
  if (!isGroup(ctx)) {
    await ctx.answerCbQuery().catch(() => {});
    return false;
  }
  if (!(await isGroupAdmin(ctx))) {
    await ctx.answerCbQuery(tpl.t("setup_admin_only"), { show_alert: true }).catch(() => {});
    return false;
  }
  return true;
}

/** Re-render a panel over the message that was tapped. Re-tapping the active
 *  preset edits a message to its own contents, which Telegram answers with
 *  "message is not modified" — nothing to do, and the toast already confirmed
 *  the value, so the failure is swallowed on purpose. */
const repaint = (ctx, panel) => ctx.editMessageText(panel.text, panel.extra).catch(() => {});

/**
 * A preset tapped on the /setminbuy picker.
 *
 * Refreshes the panel in place rather than replying, so a second adjustment is
 * another single tap on the same message instead of a new card each time.
 */
async function minBuyPick(ctx) {
  if (!(await tapAllowed(ctx))) return;
  const usd = Math.max(Number((ctx.match && ctx.match[1]) || 0), cfg.MIN_BUY_FLOOR_USD);
  await cfg.upsert(ctx.chat.id, { minBuyUsd: usd });
  await ctx.answerCbQuery(tpl.t("setminbuy_toast", { usd: usd$(usd) })).catch(() => {});
  await repaint(ctx, minBuyPanel(ctx.chat.id));
}

// Whale bars, for the picker behind 🐋 Whale bar. Coarser than the buy floor
// because it measures a BAG, not a trade: the gap between a $10k holder and a
// $50k holder is a different kind of holder, not a rounder number.
const WHALE_PRESETS = [10000, 25000, 50000, 100000, 250000];

function whaleKeyboard(g) {
  const on = g.whales !== false;
  const current = on ? Number(g.whaleWalletUsd || whaleCfg.get().walletUsd) : null;
  const btn = (n) => Markup.button.callback(usd$(n) + (current === n ? " ✓" : ""), `wb_${n}`);
  const rows = [];
  for (let i = 0; i < WHALE_PRESETS.length; i += 3) rows.push(WHALE_PRESETS.slice(i, i + 3).map(btn));
  rows.push([Markup.button.callback(on ? "🚫 Turn off" : "🚫 Off ✓", "wb_off")]);
  return Markup.inlineKeyboard(rows);
}

function whalePanel(chatId) {
  const g = cfg.get(chatId) || {};
  const on = g.whales !== false;
  const label = chainOf(g.chain)?.label || "this network";
  const { text, extra } = payloadArgs(
    tpl.render("setwhale_panel", {
      usd: on ? usd$(g.whaleWalletUsd || whaleCfg.get().walletUsd) : tpl.t("setwhale_state_off"),
      chain: label,
      // Same caveat the /setwhale confirmation carries, spliced in as raw markup
      // so the **bold** chain name survives. A group on a chain whose balances
      // cannot be read must not be shown a bar that will never fire.
      unsupported: holdings.supports(g.chain) ? "" : tpl.markup("setwhale_unsupported", { chain: label }),
    }),
    false,
  );
  return { text, extra: { ...extra, disable_web_page_preview: true, ...whaleKeyboard(g) } };
}

async function whalePick(ctx) {
  if (!(await tapAllowed(ctx))) return;
  const raw = (ctx.match && ctx.match[1]) || "off";
  if (raw === "off") {
    await cfg.upsert(ctx.chat.id, { whales: false });
    await ctx.answerCbQuery(tpl.t("setwhale_off")).catch(() => {});
  } else {
    await cfg.upsert(ctx.chat.id, { whales: true, whaleWalletUsd: Number(raw) });
    await ctx.answerCbQuery(tpl.t("setwhale_toast", { usd: usd$(Number(raw)) })).catch(() => {});
  }
  await repaint(ctx, whalePanel(ctx.chat.id));
}

/** `/setwhale 50000` — the holding that makes a buyer a whale here, or `off`. */
async function setwhale(ctx) {
  if (!isGroup(ctx)) return;
  if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
  const raw = arg(ctx).toLowerCase();
  // Bare /setwhale opens the picker, same as /setminbuy — the command menu
  // sends it with no argument, and a syntax note is a worse answer than a row
  // of bars to tap.
  if (!raw) {
    const p = whalePanel(ctx.chat.id);
    return ctx.reply(p.text, p.extra).catch(() => {});
  }
  if (raw === "off") {
    await cfg.upsert(ctx.chat.id, { whales: false });
    return say(ctx, "setwhale_off");
  }
  const usd = Number(raw.replace(/[$,_]/g, ""));
  if (!Number.isFinite(usd) || usd <= 0) return say(ctx, "setwhale_usage");
  await cfg.upsert(ctx.chat.id, { whales: true, whaleWalletUsd: usd });
  const chain = (cfg.get(ctx.chat.id) || {}).chain;
  const label = chainOf(chain)?.label || "this network";
  // Its OWN template, spliced in as raw MARKUP (not t(), which strips it — the
  // **bold** chain name reached the group as plain text), so an operator can
  // reword or delete the caveat without touching the confirmation around it.
  const unsupported = holdings.supports(chain) ? "" : tpl.markup("setwhale_unsupported", { chain: label });
  await say(ctx, "setwhale_ok", { usd: usd$(usd), chain: label, unsupported });
}

/** `/buybot pin on|off` — whether whale alerts are pinned in this group. */
async function setPin(ctx, on) {
  await cfg.upsert(ctx.chat.id, { pin: on });
  return say(ctx, on ? "pin_on" : "pin_off");
}

/**
 * /ca — "what's the contract?", the most-asked question in any token group.
 *
 * NOT admin-gated, and that is the point: the people asking are holders and
 * newcomers, not the admin who already knows. Every group answers this by hand
 * a hundred times, or pins a message that scrolls out of reach.
 *
 * The answer is deliberately NOT the /buybot status card. Somebody asking for
 * the CA wants to paste it into a wallet, not read the whale bar and the pin
 * setting. The address rides in a `code` span so one tap copies it — a
 * hand-typed contract address is a lost transaction.
 */
async function ca(ctx) {
  if (!isGroup(ctx)) return say(ctx, "setup_group_only");
  const g = cfg.get(ctx.chat.id);
  if (!g || !g.address) {
    // The same card /buybot shows on an unconfigured group, with the same
    // "📄 Add CA" button — one place that explains how to set a token, not two
    // that will eventually disagree about it.
    const p = statusPanel(ctx.chat.id);
    return ctx.reply(p.text, p.extra).catch(() => {});
  }
  const { SITE_URL } = require("../config/constants");
  const { chartUrl, tradeDeepLink } = require("../config/chains");
  const { chainEmoji } = require("../channels/format");
  const sym = String(g.sym || "").replace(/^\$/, "") || "TOKEN";
  const page = `${SITE_URL}/token/${g.chain}/${g.address}`;
  // The project's own website / X / Telegram, from DexScreener's pair info.
  // Purely additive: every failure resolves to empty rows and the socials line
  // drops out, because a third-party indexer having a bad minute must never
  // cost a member the contract address they actually asked for.
  const social = await cachedTokenLinks(g.chain, g.address);
  // "**alon** $ALON", or just "**$ALON**" when no name ever resolved — printing
  // the ticker twice is what the fallback exists to avoid. LOGIC, so it stays
  // here; the emoji in front of it is copy and lives in the template.
  const label =
    g.name && g.name !== `$${sym}`
      ? `**${premium.sanitizeVar(g.name)}** ${premium.sanitizeVar(`$${sym}`)}`
      : `**${premium.sanitizeVar(`$${sym}`)}**`;
  return say(ctx, "group_ca", {
    ...social,
    label,
    // The buy card's whole token row, for an operator who would rather this
    // card led with the network's own mark than with 💵.
    nameRow: tpl.markup("group_name_row", {
      chainEmoji: chainEmoji(g.chain),
      label,
      name: premium.sanitizeVar(g.name || ""),
      symbol: premium.sanitizeVar(`$${sym}`),
    }).trim(),
    name: premium.sanitizeVar(g.name || `$${sym}`),
    symbol: premium.sanitizeVar(`$${sym}`),
    chain: chainOf(g.chain)?.label || g.chain,
    chainEmoji: chainEmoji(g.chain),
    address: g.address,
    chartUrl: premium.sanitizeUrl(chartUrl(g.chain, g.pairAddress || g.address) || page),
    tradeUrl: premium.sanitizeUrl(tradeDeepLink(g.chain, g.address)),
    coinUrl: premium.sanitizeUrl(page),
    // dropEmpty, so a token with no socials — which is most fresh launches —
    // loses the whole row rather than leaving a blank line where it was.
  }, { dropEmpty: true });
}

/**
 * A bare "ca" in the chat is the same question without the slash.
 *
 * ONLY answered when a token IS set. /ca is explicit and always deserves a
 * reply, including the "not set up yet" card — but a bot that answers a random
 * "ca" in a group it was never pointed at is a bot posting unprompted into
 * somebody's chat, which is how it gets removed.
 */
const CA_WORD_RE = /^\/?(ca|contract)\s*[?!.]*$/i;

async function buybot(ctx) {
  if (!isGroup(ctx)) return;
  const a = arg(ctx).toLowerCase();
  const g = cfg.get(ctx.chat.id);
  if (a === "pin on" || a === "pin off") {
    if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
    return setPin(ctx, a === "pin on");
  }
  if (a === "on" || a === "off") {
    if (!(await isGroupAdmin(ctx))) return say(ctx, "setup_admin_only");
    if (!g || !g.address) return say(ctx, "buybot_need_token");
    await cfg.upsert(ctx.chat.id, { on: a === "on" });
    return say(ctx, a === "on" ? "buybot_on" : "buybot_off");
  }
  // status
  const p = statusPanel(ctx.chat.id);
  await ctx.reply(p.text, p.extra).catch(() => {});
}

/**
 * /buybot with no argument: the settings hub.
 *
 * It was a read-only status card, which meant a project could SEE every setting
 * and change none of them — each one was a separate command they had to know
 * the name and the argument shape of. Same card, now with a button per row of
 * it, so setting the bot up never requires typing anything but the contract
 * address.
 */
function settingsKeyboard(g) {
  return Markup.inlineKeyboard([
    // "📄 Token" said what the button was ABOUT, not what tapping it does. The
    // panel above already prints the CA, so the only thing left to offer is
    // replacing it.
    [Markup.button.callback("📄 Change CA", "bs_token"), Markup.button.callback("💲 Min buy", "bs_minbuy")],
    [
      Markup.button.callback("🐋 Whale bar", "bs_whale"),
      Markup.button.callback(g.pin === false ? "📌 Pin: off" : "📌 Pin: on", "bs_pin"),
    ],
    [Markup.button.callback(g.on ? "🔴 Turn the buy bot off" : "🟢 Turn the buy bot on", "bs_power")],
    // On its OWN row, deliberately not beside the power toggle. Two buttons that
    // both stop the alerts, side by side on a phone, is a mis-tap waiting to
    // happen — and this is the one that cannot be undone with the same tap.
    [Markup.button.callback("🗑 Remove CA", "bs_rmca")],
  ]);
}

/**
 * "Remove this CA?" — asked in place, over the panel that was tapped.
 *
 * A confirm step, on a feature whose whole brief was "make it as easy as
 * possible", because the cost is asymmetric: removing takes one tap and stops
 * every alert in a group where nobody is watching for that, and the first
 * anybody notices is somebody asking why the bot died. Two taps to remove,
 * still one paste to put it back.
 *
 * Editing the same message rather than sending a new one is what keeps it
 * cheap: no navigation, and cancelling puts the panel back exactly as it was.
 */
function removeConfirmPanel(chatId) {
  const g = cfg.get(chatId) || {};
  const sym = String(g.sym || "").replace(/^\$/, "");
  const { text, extra } = payloadArgs(
    tpl.render("buybot_remove_confirm", {
      symbol: sym ? `$${sym}` : "this token",
      address: g.address || "—",
    }),
    false,
  );
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Yes, remove", "bs_rmyes"),
      Markup.button.callback("↩️ Keep it", "bs_rmno"),
    ],
  ]);
  return { text, extra: { ...extra, disable_web_page_preview: true, ...kb } };
}

function statusPanel(chatId) {
  const g = cfg.get(chatId);
  // Nothing set up yet — the only button that means anything is the one that
  // starts it. Offering "min buy" on a group with no token is a dead end.
  if (!g || !g.address) {
    const { text, extra } = payloadArgs(tpl.render("buybot_need_token"), false);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("📄 Add CA", "bs_token")]]);
    return { text, extra: { ...extra, disable_web_page_preview: true, ...kb } };
  }
  const { text, extra } = payloadArgs(
    tpl.render("buybot_status", {
      address: g.address,
      chain: chainOf(g.chain)?.label || g.chain,
      pool: g.pairAddress ? "resolved ✓" : "—",
      minBuy: usd$(cfg.minBuyOf(g)),
      // The GLOBAL bar is read live, so a group that never ran /setwhale sees
      // whatever the operator currently has set — not the value baked into .env
      // at boot, which is what this line used to print.
      whale:
        g.whales === false
          ? tpl.t("setwhale_state_off")
          : usd$(g.whaleWalletUsd || whaleCfg.get().walletUsd) +
            (holdings.supports(g.chain) ? "" : " (not readable on this network)"),
      pin: g.pin === false ? "off" : "on",
      state: g.on ? "🟢 ON" : "🔴 OFF",
    }),
    false,
  );
  return { text, extra: { ...extra, disable_web_page_preview: true, ...settingsKeyboard(g) } };
}

/** A button on the settings hub. The two toggles repaint the hub in place; the
 *  two pickers open their own panel underneath it, so the hub stays put as the
 *  thing you come back to. */
async function settingsTap(ctx) {
  if (!(await tapAllowed(ctx))) return;
  const what = (ctx.match && ctx.match[1]) || "";
  const g = cfg.get(ctx.chat.id) || {};
  // ⚙️ Settings, from the confirmation card. Sent, not edited: that card is the
  // record of what was set up, and replacing it with the hub loses it.
  if (what === "home") {
    await ctx.answerCbQuery().catch(() => {});
    const p = statusPanel(ctx.chat.id);
    return void ctx.reply(p.text, p.extra).catch(() => {});
  }
  // ONE TAP from the group welcome. Which screen is right depends on whether
  // this group is already set up, and making the admin work that out is exactly
  // the friction the button exists to remove: no token yet → ask for the CA,
  // already live → show what it is doing.
  if (what === "buybot") {
    await ctx.answerCbQuery().catch(() => {});
    if (!g.address) {
      const msg = ctx.callbackQuery && ctx.callbackQuery.message;
      return promptForToken(ctx, msg && msg.message_id);
    }
    const p = statusPanel(ctx.chat.id);
    return void ctx.reply(p.text, p.extra).catch(() => {});
  }
  if (what === "token") {
    await ctx.answerCbQuery().catch(() => {});
    const msg = ctx.callbackQuery && ctx.callbackQuery.message;
    return promptForToken(ctx, msg && msg.message_id);
  }
  if (what === "minbuy") {
    await ctx.answerCbQuery().catch(() => {});
    const p = minBuyPanel(ctx.chat.id);
    return void ctx.reply(p.text, p.extra).catch(() => {});
  }
  if (what === "whale") {
    await ctx.answerCbQuery().catch(() => {});
    const p = whalePanel(ctx.chat.id);
    return void ctx.reply(p.text, p.extra).catch(() => {});
  }
  if (what === "rmca") {
    if (!g.address) {
      await ctx.answerCbQuery(tpl.t("buybot_need_token"), { show_alert: true }).catch(() => {});
      return;
    }
    await ctx.answerCbQuery().catch(() => {});
    return void repaint(ctx, removeConfirmPanel(ctx.chat.id));
  }
  if (what === "rmno") {
    await ctx.answerCbQuery().catch(() => {});
    return void repaint(ctx, statusPanel(ctx.chat.id));
  }
  if (what === "rmyes") {
    // The TOKEN goes, the group's TUNING stays. Wiping minBuyUsd / whaleWalletUsd
    // / pin along with it would make swapping a contract — the ordinary reason
    // to do this — silently reset numbers the admin chose deliberately, and they
    // would only find out from the first alert that came in under the wrong
    // floor. `on` is left alone too: cfg.active() already requires an address,
    // so a group with no CA calls nothing regardless.
    await cfg.upsert(ctx.chat.id, { address: null, pairAddress: null, sym: null, name: null });
    await ctx.answerCbQuery(tpl.t("buybot_removed_toast")).catch(() => {});
    return void repaint(ctx, statusPanel(ctx.chat.id));
  }
  if (what === "pin") {
    const on = g.pin === false;
    await cfg.upsert(ctx.chat.id, { pin: on });
    await ctx.answerCbQuery(tpl.t(on ? "pin_on" : "pin_off")).catch(() => {});
  }
  if (what === "power") {
    // Turning the bot ON without a token would report success and then call
    // nothing at all, forever.
    if (!g.address) {
      await ctx.answerCbQuery(tpl.t("buybot_need_token"), { show_alert: true }).catch(() => {});
      return;
    }
    const on = !g.on;
    await cfg.upsert(ctx.chat.id, { on });
    await ctx.answerCbQuery(tpl.t(on ? "buybot_on" : "buybot_off")).catch(() => {});
  }
  await repaint(ctx, statusPanel(ctx.chat.id));
}

module.exports = {
  settoken,
  ca,
  CA_WORD_RE,
  cachedTokenLinks,
  _linksCache: linksCache,
  tokenLinks,
  removeConfirmPanel,
  settingsKeyboard,
  groupTokenReply,
  activateTap,
  _pendingActivate: pendingActivate,
  setchain,
  setminbuy,
  minBuyPick,
  setwhale,
  whalePick,
  buybot,
  settingsTap,
  setPin,
  resolveToken,
  resolveTokenSoon,
  candidateChains,
  MIN_BUY_PRESETS,
  WHALE_PRESETS,
};
