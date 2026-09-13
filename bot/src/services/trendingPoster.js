// Maintains a single "Dexvra Trending" message in @dexvratrending, edited in
// place (no new-post spam / no visible minute pattern). Persists the message id
// so a restart re-edits the same message. Skips when the text is unchanged.
const { TRENDING_POST_MS, CHANNELS, SITE_URL } = require("../config/constants");
const api = require("../api/dexvra");
const { chainOf, CHAIN_ORDER } = require("../config/chains");
const { tierRank } = require("../config/packages");
// Imported as a MODULE, not destructured: a captured binding cannot be swapped,
// and the price source has to be stubbable for a test to pin what the board
// renders when a reading is missing — which is the defect this file was fixed
// for. Same reason autoTrend.js states at its own require.
const market = require("../marketdata");
const board = require("./trendingBoard");
const gramjs = require("../gramjs");
const premium = require("../premium");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

const STATE_FILE = "trendpost.json";
const MAX_PER_CHAIN = 10;
// lastMode = how the last successful post RENDERED ("premium" = custom-emoji
// entities went out via the premium account, "plain" = unicode fallbacks). It's
// part of the skip check: without it a board whose text never changes would stay
// stuck on unicode forever after the premium account finally came online.
let state = loadJSONSync(STATE_FILE, { messageId: null, lastText: null, lastMode: null });

// After Telegram REFUSES our custom emoji (account isn't Premium / dead emoji
// id) stop paying for the doomed premium attempt for a while. It expires on its
// own, so the board upgrades itself once the account is fixed — no restart.
const PREMIUM_RETRY_MS = 30 * 60 * 1000;
let premiumBlockedUntil = 0;
// This loop runs every few minutes — warn at most hourly per distinct reason.
const warnedAt = new Map();
function warnOnce(key, msg) {
  const now = Date.now();
  if (now - (warnedAt.get(key) || 0) < 60 * 60 * 1000) return;
  warnedAt.set(key, now);
  log.warn(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ⚠️ HOW MANY ROWS THIS CHAIN SHOWS — rolled inside [min, max], not pinned to
 * the minimum.
 *
 * "mengapa semua chain 5 5 doang kan random min 5 max 8". The first cut of the
 * website mirror filled every chain to `perChainMin`, so all six published
 * exactly five rows for ever — which is precisely the defect the RANGE was
 * added to end: "one fixed perChain: 5 made every chain publish the same count
 * for ever, which reads as a generated list rather than a board".
 *
 * ⚠️ AND IT MAY NOT BE RE-ROLLED ON EVERY PUBLISH. The board is edited in place
 * every few minutes; a fresh roll each time would make the row count flicker
 * 5 → 8 → 6 → 5 while somebody is reading it. So the roll is DETERMINISTIC in
 * the chain and a time BUCKET: different chains differ from each other at any
 * moment, each one holds its count for hours, and it moves on by itself. No
 * stored state, so nothing to reset and nothing to leak between processes —
 * the poster runs in one and the panel in another.
 *
 * The promoter's own `rollTarget()` is untouched and answers a different
 * question: how many slots to BOOK. Booked rows always render, so a chain that
 * booked more than this shows more — this is a floor for the top-up, never a
 * cap on a purchase.
 */
const TARGET_BUCKET_MS = Math.max(
  600_000,
  (Number(process.env.TREND_TARGET_BUCKET_HOURS) || 3) * 3600_000,
);
function rolledTarget(chain, min, max, now = Date.now()) {
  if (!(max > min)) return min; // a pinned range is a fixed count, and says so
  const bucket = Math.floor(now / TARGET_BUCKET_MS);
  // FNV-1a over chain+bucket: cheap, stable, and spread enough that six chains
  // do not land on the same number. `>>> 0` because Math.imul can go negative
  // and a negative modulus would bias the low end back towards the floor.
  let h = 2166136261;
  const key = `${chain}:${bucket}`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return min + ((h >>> 0) % (max - min + 1));
}
// Board priority: paid tier first (Diamond=1 … Bronze=5), then Xpress/none last.
const tierPrio = (tier) => {
  const r = tierRank(tier);
  return r > 0 ? r : 99;
};
// Full comma number + "$" (fourtis style: 23,868,066$).
const mcapStr = (n) => (Number.isFinite(n) && n > 0 ? `${Math.round(n).toLocaleString("en-US")}$` : "");
// Last line of defence before a number reaches a PINNED public board. A six-
// digit percentage is always broken upstream data (a pool created hours ago
// measured against a near-zero opening tick) — printing nothing is honest,
// printing "+521366.00%" is not. marketdata.js filters these at the source;
// this is here because the board is what subscribers actually read.
const SANE_PCT = 5000;
const pctStr = (n) =>
  Number.isFinite(n) && Math.abs(n) <= SANE_PCT ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "";
// What goes in the percentage column when there is no percentage to put there.
//
// "beberapa token di trending channel mengapa tidak ada kenaikan atau penurunan
// %" — the segment simply DROPPED, so the row rendered as `1 | $MOONCOIN |
// 12,220,809$` and read as broken to 10,593 subscribers. A blank was the honest
// answer to "we could not read it" and it is still not a 0% — inventing one is
// a claim nobody measured, which is the rule this board has always been built
// on. What was wrong is that honest and INVISIBLE are different things.
//
// So the column is always filled, and a mark that is plainly not a number says
// what a missing number means. Everything above this line — the candle
// recovery in marketdata, the promoter's `hasReading`, the filler's — exists so
// that only a slot somebody PAID for can still reach it.
const NO_READING = "—";
// Normalize a token's Telegram (handle / t.me / full url) into a t.me URL, or null.
function tgUrl(tg) {
  if (!tg) return null;
  let s = String(tg).trim();
  if (/^https?:\/\//i.test(s)) return s;
  s = s.replace(/^@/, "").replace(/^t\.me\//i, "");
  return s ? `https://t.me/${s}` : null;
}
// Normalize a token's X/Twitter (handle / url) into an x.com URL, or null.
function xUrl(x) {
  if (!x) return null;
  let s = String(x).trim();
  if (/^https?:\/\//i.test(s)) return s;
  s = s.replace(/^@/, "").replace(/^(x\.com|twitter\.com)\//i, "");
  return s ? `https://x.com/${s}` : null;
}
// Normalize a website (bare domain or url) into an absolute URL, or null.
function webUrl(w) {
  if (!w) return null;
  const s = String(w).trim();
  if (/^https?:\/\//i.test(s)) return s;
  return s.includes(".") ? `https://${s}` : null;
}

// The board is built in PREMIUM MARKUP (**bold**, [text](url), and rank/logo
// fragments that may be premium-emoji markup "[🥇](emoji/ID)"). premium.parse()
// turns it into {text, entities} — the ONLY way custom (premium) emoji render,
// sent by the GramJS premium account. Dynamic text/urls are sanitized so a
// token symbol or link can't break the [..](..) / [..](emoji/id) markup.
const mkText = (s) => String(s == null ? "" : s).replace(/[[\]()`*]/g, "").replace(/\s+/g, " ").trim();
const mkUrl = (u) => String(u == null ? "" : u).replace(/[)\s]/g, "");

async function buildText() {
  const now = Date.now();
  const all = await api.getListings();
  const featured = all.filter(
    (r) => r.status === "approved" && r.trendingRank != null && (!r.trendExp || r.trendExp > now),
  );
  // ⚠️ NOT `if (!featured.length) return null` ANY MORE — see the end of this
  // function. A board with no BOOKED slot is no longer a board with nothing to
  // show: the website's ranking can fill it on its own. That early return meant
  // a promoter that stalled and let every slot expire took the whole board down
  // with it — which is exactly the nine-hour outage this session spent the day
  // chasing. "Nothing to publish" is now measured from the rows actually drawn.

  const byChain = {};
  for (const r of featured) (byChain[r.chain] ||= []).push(r);

  // ── THE BOARD MIRRORS THE WEBSITE ────────────────────────────────────────
  //
  // "di website sudah ada trending, nah itu aja yang diambil, harus sinkron" —
  // a project opens dexvra.io and the channel side by side and sees two
  // different sets of tokens, because the two answer "what is trending" from
  // different places: the site ranks every listing by 24h %, this renders
  // whoever holds a booked slot. And a chain with fewer booked slots than the
  // operator's minimum published a short board for six rounds running.
  //
  // ⚠️ BOOKED SLOTS ARE PINNED AND ARE NEVER REPLACED. Somebody PAID for those
  // rows; a board that dropped a purchase because the token was down that day
  // is a refund conversation, and this repo's own rule on every other ranking
  // surface is that a paid row demotes, never disappears. The site's ranking
  // fills what is LEFT, in the site's own order — so everything nobody bought
  // matches dexvra.io exactly, and a purchase still gets its row.
  //
  // ⚠️ AND THE ORDER IS READ, NEVER RECOMPUTED. `byChange` on the site is the
  // one owner of "which change may rank this"; a copy of it here is the fourth
  // private answer to that question in this repo, and the first three are what
  // put `$MRNA +465%` on five cents of volume at the top of a public board.
  let siteRank = {};
  let siteLive = false;
  // ⚠️ WHY THE TOP-UP DID OR DID NOT HAPPEN, reported on every publish.
  //
  // The first cut of this had a `warnOnce` on failure and NOTHING on success —
  // so "the site was unreachable", "the site is on demo data", "there was
  // nothing readable to add" and "it worked" were one observation from the
  // channel: a short board. That is the exact defect this session has now had
  // to fix three times in autoTrend, reintroduced by the code written to end
  // it. A board that is short must be able to say which of the four it is.
  let fillWhy = null;
  try {
    const rank = await api.boardRank("24h");
    // ⚠️ DEMO DATA MAY NOT REACH THE CHANNEL. `live:false` is the site saying
    // these are captured-at-listing numbers, not readings — publishing a board
    // built from them would be the fabricated figure this file already refuses
    // to render, arrived at one layer earlier.
    if (rank && rank.live) {
      siteRank = rank.chains || {};
      siteLive = true;
    } else {
      // The site fell back to captured-at-listing rows. Publishing those is the
      // fabricated figure this board refuses to render, one layer earlier — so
      // the top-up stands down, and says so, because "dexvra.io is itself on
      // demo data" is an outage the operator can act on and is nothing to do
      // with their trending settings.
      fillWhy = "the site's own board is not live (demo data) — nothing to mirror";
      warnOnce("rank-demo", `[trending] ${fillWhy}`);
    }
  } catch (e) {
    // A board that vanished is worse than one that is short: the booked slots
    // are still real and still paid for, so they go out either way.
    fillWhy = `could not read the site's ranking: ${e.message}`;
    warnOnce("rank-fail", `[trending] ${fillWhy}, publishing booked slots only`);
  }
  // Per chain: booked rows, and how many the site's order added on top.
  const fillStat = [];
  const keyOf = (chain, address) => `${chain}:${String(address || "").toLowerCase()}`;
  // The operator's own "minimum N per chain", read from the one place that
  // owns it (⚙️ Auto-Trend). A second number here is how the panel and the
  // channel would come to disagree about what the minimum is — which is the
  // shape of every round of this report. Lazily required: autoTrend does not
  // require this module, so there is no cycle, but the dependency is one-way
  // and stating it at the call site keeps it that way.
  const atCfg = require("./autoTrend").get();
  const perChainMin = Number(atCfg.perChainMin) || 0;
  const perChainMax = Math.max(perChainMin, Number(atCfg.perChainMax) || perChainMin);
  // ⚠️ THE TOP-UP ONLY EVER TOUCHES THE OPERATOR'S OWN CHAINS.
  //
  // `cfg.chains` is "the networks auto-trending keeps alive", and its comment
  // has always finished the sentence: "Everything else is PAID-ONLY". The first
  // cut of the mirror filled every chain in CHAIN_ORDER, so the board grew
  // POLYGON, OPTIMISM, BERACHAIN and HYPEREVM sections overnight — four
  // networks the operator had never put on it, each topped up to five rows,
  // reported as "hapus polygon hyper optimis". A booked slot on any chain still
  // publishes: somebody paid for that row, and this list governs what the bot
  // adds by itself, never what a purchase may buy.
  const autoChains = new Set((atCfg.chains || []).map((c) => String(c).toLowerCase()));

  // Title emoji is admin-settable (@dexvraadminbot → Trending board) so the
  // operator can make it a premium, animated fire without a redeploy.
  const lines = [`${board.titleEmoji()} **Dexvra Trending** — live featured slots`];
  let newCount = 0;
  let noReadCount = 0;
  let rowCount = 0;
  const blank = [];
  for (const chain of CHAIN_ORDER) {
    let booked = byChain[chain] || [];
    // ⚠️ A CHAIN THE OPERATOR SWITCHED OFF DOES NOT GET A SECTION AT ALL.
    //
    // "saya tidak ingin chain ini ada di channel trending" — POLYGON, OPTIMISM,
    // BERACHAIN and HYPEREVM had grown their own headings on a board meant to
    // carry six networks. Gating only the TOP-UP was not enough: a chain with a
    // booked slot still rendered, so the sections stayed. The operator's list
    // decides what the board COVERS, not merely what the bot may add to it.
    //
    // ⚠️ …EXCEPT A ROW SOMEBODY BOUGHT, which is never dropped silently. A real
    // paid tier on a switched-off chain is a contradiction only the operator
    // can resolve, and this repo's standing rule is that a purchase demotes
    // rather than disappears. It publishes, and the ops channel is told once —
    // a refund conversation must not start with a row vanishing unannounced.
    if (!autoChains.has(String(chain).toLowerCase())) {
      const paid = booked.filter((r) => tierPrio(r.tier) < 99);
      if (!paid.length) continue;
      warnOnce(
        `off-chain-paid:${chain}`,
        `[trending] ${chain} is switched OFF on ⚙️ Auto-Trend, but ${paid.length} PAID slot(s) are live there ` +
          `(${paid.map((r) => r.sym || r.address).join(", ")}) — publishing them rather than dropping a purchase. ` +
          `Turn the chain back on, or let the slot expire.`,
      );
      booked = paid;
    }
    // Top up from the site's order, skipping anything already booked here.
    const shown = new Set(booked.map((r) => keyOf(r.chain, r.address)));
    const fill = [];
    // ⚠️ AND A SWITCHED-OFF CHAIN THAT SURVIVED ON A PAID ROW IS NEVER TOPPED
    // UP. The section gate above lets a purchase through; it does not put the
    // chain back on the board. Without this the exception re-created the very
    // section the operator switched off, with one bought row and four free ones
    // under it — the fix producing a worse version of the bug it fixes.
    const mayFill = autoChains.has(String(chain).toLowerCase());
    const target = rolledTarget(chain, perChainMin, perChainMax, now);
    for (const t of (mayFill ? siteRank[chain] || [] : [])) {
      if (fill.length >= Math.max(0, target - booked.length)) break;
      if (shown.has(keyOf(t.chain, t.address))) continue;
      // ⚠️ A ROW WITH NO READING MAY NOT BE PUT ON THE BOARD BY US. The site
      // sends `null` for a change it could not read, and this board's standing
      // rule is that a slot it books ITSELF must carry a percentage — the
      // promoter and the market filler both honour it. A paid slot keeps its
      // row and renders `—`; a row we chose has no such claim on the space.
      if (!Number.isFinite(t.change24h)) continue;
      shown.add(keyOf(t.chain, t.address));
      fill.push(t);
    }
    if (booked.length || fill.length) {
      fillStat.push(`${chain} ${booked.length}+${fill.length}/${target}`);
    }
    const arr = [...booked, ...fill.map((t) => ({
      chain: t.chain,
      address: t.address,
      sym: t.symbol,
      // No tier: these are not purchases, and `tierPrio` must sort them below
      // every paid row. Nothing here writes to the store — the board mirrors
      // the site, it does not book anything.
      tier: undefined,
      _fromSite: t,
    }))];
    if (!arr.length) continue;
    // Pull live 24h change + market cap for each token (polite to GeckoTerminal).
    const enriched = [];
    for (const r of arr) {
      // ⚠️ A ROW THE SITE SUPPLIED IS NOT RE-PRICED. The site priced it this
      // cycle and sent the figure; asking again would spend the shared
      // GeckoTerminal ceiling to re-derive a number we were just handed — and
      // would let the two surfaces print different percentages for the same
      // token, which is the desync this whole change exists to end.
      if (r._fromSite) {
        enriched.push({ r, change: r._fromSite.change24h, mcap: r._fromSite.mcap, why: null });
        continue;
      }
      const m = await market.fetchMarket(r.chain, r.address).catch(() => null);
      await sleep(300);
      enriched.push({
        r,
        change: m && Number.isFinite(m.change24h) ? m.change24h : null,
        mcap: m && Number.isFinite(m.mcap) ? m.mcap : null,
        // WHY there is no reading, carried from marketdata. Recorded, not
        // rendered: the board may not explain itself to 10,593 subscribers,
        // but the operator has now asked this question twice and the answer
        // was thrown away both times.
        why: (m && m.changeWhy) || (m ? null : "no market anywhere — no GeckoTerminal pool and no DexScreener pair"),
      });
    }
    // Rank by PACKAGE tier first (top-tier buyers on top), then by 24h performance.
    enriched.sort((a, b) => {
      const d = tierPrio(a.r.tier) - tierPrio(b.r.tier);
      if (d !== 0) return d;
      return (b.change ?? -Infinity) - (a.change ?? -Infinity);
    });
    lines.push(`\n${board.chainLogo(chain)} **${mkText(chainOf(chain).label.toUpperCase())} - Trending**`);
    enriched.slice(0, MAX_PER_CHAIN).forEach((e, i) => {
      const sym = mkText(String(e.r.sym || "").replace(/^\$/, ""));
      const dexUrl = `${SITE_URL}/token/${e.r.chain}/${e.r.address}`;
      // $TICKER prefers Telegram → then X → then Website; only if the token has
      // none of those does it fall back to its Dexvra page (never a dead link).
      // MARKET CAP → the Dexvra token page (its CA).
      const tickerHref = tgUrl(e.r.telegram) || xUrl(e.r.twitter) || webUrl(e.r.website) || dexUrl;
      const link = `[$${sym}](${mkUrl(tickerHref)})`;
      const pct = pctStr(e.change) || NO_READING;
      if (pct === NO_READING) {
        noReadCount++;
        blank.push({ chain, sym: sym || String(e.r.address).slice(0, 8), why: e.why });
      }
      const mc = mcapStr(e.mcap);
      const mcLink = mc ? `[${mc}](${mkUrl(dexUrl)})` : "";
      // {badge} {🌩} {+%} | $TICKER(→TG) | {mcap}$(→Dexvra) — parts drop cleanly
      // if missing. The 🌩 marks a slot that STARTED in the last few hours: the
      // board is edited in place, so without it the message looks identical at
      // 09:00 and 15:00 and a returning reader cannot see what just entered.
      rowCount++;
      const isNew = board.isNewlyTrending(e.r, now);
      if (isNew) newCount++;
      const segs = [board.rankBadge(i + 1), isNew ? board.newEmoji() : "", pct, "|", link];
      if (mcLink) segs.push("|", mcLink);
      lines.push(segs.filter(Boolean).join(" "));
    });
  }
  // No footer link. Every $TICKER and market cap on the board is already a link
  // (to the token's socials and its Dexvra page), so a trailing "View all on
  // Dexvra" only added a line of chrome to a board that is edited in place and
  // read at a glance — operator's call, 2026-07-25.
  //
  // The legend is the exception, and only when it has something to explain: a
  // symbol nobody defined is noise, and printing "🌩 = newly entered" on a board
  // with no 🌩 on it is worse — it sends the reader hunting for a mark that is
  // not there.
  // ⚠️ ONE LINE PER PUBLISH, at info. `booked+filled` per chain, and the reason
  // when nothing was mirrored. This is the only thing that separates "the
  // top-up ran and the site had nothing readable to add" from "the bot could
  // not reach the site at all" — and from the channel both render as a board
  // that is still short, which is how six rounds of this were each diagnosed
  // from scratch.
  log.info(
    `[trending] board: ${fillStat.join(" · ") || "nothing featured"}` +
      ` (booked+from-site/target, range ${perChainMin}–${perChainMax}/chain)` +
      (siteLive ? "" : ` — NOT mirrored: ${fillWhy || "unknown"}`),
  );
  if (newCount > 0) {
    const h = board.newHours();
    lines.push(`\n${board.newEmoji()} = Newly Entered Trending (slot started in the last ${h} hour${h === 1 ? "" : "s"})`);
  }
  // Same rule as the newly-entered legend directly above: printed only when
  // there is something on the board for it to explain. A mark nobody defined is
  // noise; a definition for a mark that is not there sends the reader hunting.
  // (No emoji literal in here — newTrendingMark.test.js reads this whole region
  // and fails on a legend that hardcodes what it is supposed to quote.)
  if (noReadCount > 0) {
    lines.push(`${newCount > 0 ? "" : "\n"}${NO_READING} = no 24h reading for this pool yet`);
  }
  // ⚠️ MEASURED AT THE MOMENT THE BOARD GOES OUT, from the very rows it drew.
  //
  // `noReadCount` was computed here and thrown away, which is the defect this
  // repo keeps re-learning — the gainers banner measured its candidate `pool`,
  // returned it, and printed it nowhere, so a collapsed ranking looked entirely
  // normal. A value nobody can read is the same as no value.
  //
  // Recording it HERE rather than re-deriving it elsewhere is the `fonts:check`
  // rule: a guard is only honest while it measures the stack the renderer
  // actually used. `trending:check --rows` reads this, so it can never report a
  // clean board while this function publishes dashes.
  lastRender = { at: now, rows: rowCount, blank };
  // Nothing booked AND nothing to mirror — a title with no rows under it is not
  // a board, and editing the pinned message down to one line is worse than
  // leaving the last good one in place.
  if (!rowCount) return null;
  return lines.join("\n");
}

// The last board this process RENDERED — not what it decided to send, and not a
// second lookup of the same question. `{ at, rows, blank:[{chain,sym,why}] }`,
// or null before the first render.
let lastRender = null;
const getLastRender = () => lastRender;

// Remove a superseded board message so the channel never accumulates duplicate
// boards (the visible symptom of a transport flip). Only the identity that POSTED
// a message may delete it, so this routes by the recorded owner. Best-effort.
async function dropMessage(tg, owner, messageId) {
  try {
    if (owner === "gramjs") await gramjs.deleteChannelMessage(CHANNELS.trending, messageId);
    else await tg.deleteMessage(CHANNELS.trending, messageId);
    log.info(`[trendposter] removed superseded board message #${messageId} (${owner})`);
  } catch (e) {
    log.debug(`[trendposter] could not delete old board #${messageId}: ${e.message}`);
  }
}

// Make sure the board we maintain is the message readers actually see pinned.
// A duplicate board left by an older run (transport flip used to strand one) can
// otherwise stay pinned forever while we quietly edit a DIFFERENT message — the
// pinned board then "never changes" no matter how well posting works. Once per
// process, best-effort; re-pinning an already-pinned message is a no-op.
let pinnedThisRun = false;
async function ensurePinned(tg, transport) {
  if (pinnedThisRun || !state.messageId) return;
  pinnedThisRun = true;
  try {
    if (transport === "gramjs") await gramjs.pinChannelMessage(CHANNELS.trending, state.messageId);
    else await tg.pinChatMessage(CHANNELS.trending, state.messageId, { disable_notification: true });
    log.info(`[trendposter] board #${state.messageId} pinned (${transport})`);
  } catch (e) {
    log.debug(`[trendposter] pin #${state.messageId}: ${e.message}`);
  }
}

// Edit (or, on failure, re-post) the board through ONE transport. A message can
// only be edited by the account that sent it, so the transport that owns the
// current message must match; otherwise we post fresh, record the new owner and
// delete the old message — posting FIRST so the channel is never boardless.
//
// A premium-emoji rejection is rethrown untouched: re-posting would fail
// identically, and flipping transport would strand a duplicate board. The caller
// retries on this same transport with the custom emoji stripped, which then just
// EDITS the existing message.
async function postVia(tg, transport, payload, markup, mode) {
  const editIt = () =>
    transport === "gramjs"
      ? gramjs.editChannelMessage(CHANNELS.trending, state.messageId, payload)
      : tg.editMessageText(CHANNELS.trending, state.messageId, undefined, payload.text, {
          entities: payload.entities,
          disable_web_page_preview: true,
        });
  const sendFresh = async () => {
    const prev = state.messageId ? { id: state.messageId, owner: state.transport } : null;
    let msg;
    if (transport === "gramjs") {
      msg = await gramjs.sendToChannel(CHANNELS.trending, { text: payload.text, entities: payload.entities, pin: true });
    } else {
      msg = await tg.sendMessage(CHANNELS.trending, payload.text, {
        entities: payload.entities,
        disable_web_page_preview: true,
      });
      tg.pinChatMessage(CHANNELS.trending, msg.message_id, { disable_notification: true }).catch(() => {});
    }
    state.messageId = msg.message_id;
    state.transport = transport;
    if (prev) await dropMessage(tg, prev.owner, prev.id);
  };
  const settle = async (how) => {
    state.lastText = markup;
    state.lastMode = mode;
    await saveJSON(STATE_FILE, state);
    // ONE line per publish, at info: transport, render mode and how many premium
    // emoji actually went out. Without it "the board never changes" is
    // unanswerable from pm2 logs — a silent success and a silent failure look
    // exactly the same in the channel.
    const nPrem = (payload.entities || []).filter((e) => e.type === "custom_emoji").length;
    log.info(`[trendposter] board ${how} via ${transport} — ${mode}, ${nPrem} premium emoji → #${state.messageId}`);
    await ensurePinned(tg, transport);
    // Returned so a caller can SAY what happened. @dexvraadminbot's "🔄 Refresh
    // board now" reports this back in the chat: an operator who has just set a
    // badge should not have to read pm2 logs to learn whether the board went out
    // premium or degraded to plain — those two look identical in the channel to
    // anyone without Telegram Premium.
    return { how, transport, mode, premium: nPrem, messageId: state.messageId };
  };

  if (state.messageId && state.transport === transport) {
    try {
      await editIt();
      return await settle("edited");
    } catch (e) {
      if (/not modified/i.test(e.message || "")) return await settle("unchanged");
      if (transport === "gramjs" && gramjs.isPremiumEmojiError(e)) throw e; // caller degrades in place
      log.debug(`[trendposter] ${transport} edit failed (${e.message}) — posting fresh`);
    }
  }
  await sendFresh(); // throws with state.messageId untouched, so no phantom id
  return await settle("posted");
}

/**
 * Fold this render into the "every row carries a percentage" watch and post any
 * alert. Never throws — a diagnostic must never be why a cycle fails, the rule
 * autoTrend's board watch is written under.
 *
 * The state is persisted only when it CHANGES: a value written to the store
 * every cycle for nobody is disk churn plus a field the next person has to work
 * out is dead — the lesson `peakValueEth` left behind.
 */
async function watchRows() {
  try {
    const rec = getLastRender();
    if (!rec) return;
    const watch = require("./trendingWatch");
    const { state: next, alerts } = watch.evaluateRows(rec, state.rowWatch || {});
    if (JSON.stringify(next) !== JSON.stringify(state.rowWatch || {})) {
      state.rowWatch = next;
      await saveJSON(STATE_FILE, state);
    }
    for (const a of alerts) log.alert(a.text);
  } catch (e) {
    log.debug(`[trendposter] row watch: ${e.message}`);
  }
}

// One refresh cycle. Exported so the premium / degrade paths are testable
// without waiting on the interval. Never throws — a bad cycle just skips.
async function runOnce(tg) {
  try {
    const markup = await buildText();
    if (!markup) return { how: "empty", mode: null, premium: 0 };
    // ⚠️ BEFORE the unchanged/transport branches below, deliberately.
    //
    // The question "did the board that just rendered carry a percentage on
    // every row" is answered by buildText, and it is just as true on a cycle
    // that publishes nothing because the text did not change. Evaluating after
    // the `unchanged` early return would freeze the watch on exactly the boards
    // that sit blank the longest — a stuck symptom reading as no symptom, which
    // is the state that looks most like a healthy one.
    await watchRows();
    const parsed = premium.parse(markup);
    // Custom emoji from a BOT render only in private/group/supergroup chats,
    // and only when the bot's OWNER has Telegram Premium (Bot API formatting
    // rules) — never in a channel, which is where this board lives. Drop them
    // on the Bot API fallback so the unicode char shows; GramJS (a premium
    // USER account) is the one transport that can render them here.
    const botEntities = parsed.entities.filter((e) => e.type !== "custom_emoji");
    const hasPremiumEmoji = parsed.entities.length !== botEntities.length;

    const premiumUsable = hasPremiumEmoji && gramjs.available() && Date.now() >= premiumBlockedUntil;
    const mode = premiumUsable ? "premium" : "plain";
    // Re-render when the TEXT changed OR when the board can render in a different
    // MODE than last time (premium account just came online / just went away).
    if (markup === state.lastText && mode === state.lastMode)
      return { how: "unchanged", mode, premium: parsed.entities.length - botEntities.length, messageId: state.messageId };

    // Prefer the GramJS premium account — the ONLY way custom emoji render.
    if (premiumUsable) {
      try {
        return await postVia(tg, "gramjs", { text: parsed.text, entities: parsed.entities }, markup, "premium");
      } catch (e) {
        if (gramjs.isPremiumEmojiError(e)) {
          // Telegram refused the emoji themselves — the account almost certainly
          // isn't Telegram Premium (or an id is dead). Degrade IN PLACE on the
          // same transport (same message, no duplicate) and back off.
          premiumBlockedUntil = Date.now() + PREMIUM_RETRY_MS;
          gramjs.recordEmojiRefusal(e.message); // surfaces in /premium (admin bot)
          warnOnce(
            "premium-refused",
            `[trendposter] Telegram REFUSED the premium emoji (${e.message}) — is the GramJS account actually Telegram Premium? Board renders UNICODE; retrying in ${Math.round(PREMIUM_RETRY_MS / 60000)}min. Diagnose with /premium in @dexvraadminbot.`,
          );
          try {
            return { ...(await postVia(tg, "gramjs", { text: parsed.text, entities: botEntities }, markup, "plain")), why: e.message };
          } catch (e2) {
            log.warn(`[trendposter] gramjs unicode post also failed → bot-api fallback: ${e2.message}`);
          }
        } else {
          log.warn(`[trendposter] premium (gramjs) post FAILED → bot-api fallback (unicode): ${e.message}`);
        }
      }
    } else if (hasPremiumEmoji && !gramjs.available()) {
      warnOnce(
        "premium-offline",
        "[trendposter] board has premium emoji but the premium account is NOT connected — posting UNICODE. Run: node scripts/gramjs-login.js (diagnose with /premium in @dexvraadminbot)",
      );
    }
    return {
      ...(await postVia(tg, "bot", { text: parsed.text, entities: botEntities }, markup, "plain")),
      // WHY it is plain, in the caller's terms. "The board is not premium" has
      // three unrelated causes and they need three different answers.
      why: hasPremiumEmoji
        ? gramjs.available()
          ? "the premium account is cooling down after a refusal"
          : "the premium account is not connected"
        : "no slot on the board carries a premium emoji",
    };
  } catch (e) {
    // A cycle that dies here publishes NOTHING, and at debug level that is
    // invisible — "the board just never changes" with no trace in pm2 logs.
    // Throttled so a persistent outage doesn't flood the log channel.
    warnOnce("cycle-failed", `[trendposter] refresh cycle FAILED: ${e.message}`);
    log.debug(`[trendposter] ${e.stack || e.message}`);
    return { how: "failed", mode: null, premium: 0, why: e.message };
  }
}

function start(tg) {
  const run = () => runOnce(tg);
  const iv = setInterval(run, TRENDING_POST_MS);
  const kick = setTimeout(run, 8000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, runOnce, buildText, lastRender: getLastRender, _rolledTarget: rolledTarget };
// Exposed for tests: reset the in-memory post state between cases.
module.exports._resetState = () => {
  lastRender = null;
  state = { messageId: null, lastText: null, lastMode: null };
  premiumBlockedUntil = 0;
  pinnedThisRun = false;
  warnedAt.clear();
};
