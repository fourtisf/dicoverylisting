// Banner Ads flow: pick a banner type → duration → upload the creative → link →
// title → description → contract address → socials → choose a pay currency
// (USD price converted to native) → pay.
//
// Everything after the link is the ADVERTISER'S OWN COPY for the @dexvraio
// announcement (see post_banner): their description, their CA, their socials.
// Each step takes /skip, because plenty of campaigns are a service or an event
// with no token and no channels — the post drops whatever is missing.
const { answer, toast, sendCard, getMediaFileId } = require("../helpers/message");
const { nativeOf } = require("../config/chains");
const { networkLabel } = require("../config/payOptions");
const { BANNERS, bannerByKey } = require("../config/packages");
const { escapeHtml } = require("../helpers/format");
const { usdToNative } = require("../nativeprice");
const { startPayment } = require("./pay");
const menu = require("./menu");
const { Markup } = menu;

const URL_RE = /^https?:\/\/\S+$/i;
// Pay currencies offered for USD-priced banners (one per native coin).
// Banner ads are billed in USD and quoted per chain (usdToNative), so this list
// IS the network picker for this flow — which is why Robinhood being absent was
// the whole of its half of "pay in ETH on either network". Ethereum and
// Robinhood both quote from the ETH price, so the two rows show the same amount
// on purpose: a choice of rail, not of price.
//
// ⚠️ WHICH IS EXACTLY WHY EVERY ROW MUST NAME ITS RAIL. Adding Robinhood put a
// SECOND `0.0500 ETH` button directly under the first, byte-identical, on the
// one screen where this flow decides which network settles the order — and it
// decides it for good, because `payChain` below pins whatever was tapped. Two
// indistinguishable buttons, one arming Ethereum mainnet and one arming
// Robinhood Chain, and the mistake they invite is mainnet ETH sent to a
// Robinhood address: an uncreditable transfer. `networkLabel` is the SAME owner
// pay.js's own picker reads, so the two screens can never come to spell a
// network differently.
const PAY_CHAINS = ["solana", "bsc", "ethereum", "robinhood", "tron", "ton"];

function freshSession(ctx, patch) {
  const prev = ctx.session && ctx.session.latest_bot_message;
  ctx.session = { latest_bot_message: prev, ...patch };
}

async function entryBanner(ctx) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  freshSession(ctx, { type: "banner", bannerForm: {} });
  const rows = BANNERS.map((b) => [Markup.button.callback(`${b.name} (${b.size})`, `bt_${b.key}`)]);
  const tpl = require("../templates");
  await sendCard(ctx, tpl.render("intro_banner"), menu.withHome(rows));
}

async function typePick(ctx) {
  await answer(ctx);
  const key = ctx.match[1];
  const pack = bannerByKey(key);
  if (!pack) return toast(ctx, "Unknown banner type.");
  ctx.session.bannerForm = { key, name: pack.name, size: pack.size, slot: pack.name };
  const rows = pack.rows.map((r, i) => [
    Markup.button.callback(`${r.duration} · $${r.usd}${r.discount ? ` (-${r.discount}%)` : ""}`, `bd_${i}`),
  ]);
  const tpl = require("../templates");
  await sendCard(ctx, tpl.render("banner_duration_prompt", { name: pack.name, size: pack.size }), menu.withHome(rows));
}

async function durationPick(ctx) {
  await answer(ctx);
  const bf = ctx.session.bannerForm;
  if (!bf || !bf.key) return toast(ctx, require("../templates").render("session_expired"));
  const pack = bannerByKey(bf.key);
  const row = pack.rows[Number(ctx.match[1])];
  if (!row) return toast(ctx, "Invalid duration.");
  bf.hours = row.hours;
  bf.usd = row.usd;
  bf.duration = row.duration;
  ctx.session.awaitingField = "banner_image";
  // {size2x} is the same shape at twice the pixels — Telegram compresses photos,
  // so uploading at the literal sold size lands soft in a 2560-wide post.
  const dbl = String(bf.size).replace(/(\d+)/g, (n) => String(Number(n) * 2));
  await sendCard(ctx, require("../templates").render("banner_image_prompt", { size: bf.size, size2x: dbl }), menu.withHome([]));
}

async function handlePhoto(ctx) {
  const s = ctx.session;
  if (!s.bannerForm || s.awaitingField !== "banner_image") return;
  const id = getMediaFileId(ctx);
  if (!id) return toast(ctx, "I couldn't read that image — send it as a photo.");
  s.bannerForm.imageFileId = id;
  s.awaitingField = "banner_link";
  await sendCard(ctx, require("../templates").render("banner_link_prompt"), menu.withHome([]));
}

async function handleText(ctx) {
  const s = ctx.session;
  const bf = s.bannerForm;
  if (!bf) return;
  const input = (ctx.message.text || "").trim();

  if (s.awaitingField === "banner_link") {
    if (!URL_RE.test(input)) return toast(ctx, require("../templates").render("invalid_url"));
    bf.linkUrl = input;
    s.awaitingField = "banner_title";
    return sendCard(ctx, require("../templates").render("banner_title_prompt"), menu.withHome([]));
  }
  if (s.awaitingField === "banner_title") {
    bf.title = input === "/skip" ? null : input.slice(0, 60);
    s.awaitingField = "banner_desc";
    return sendCard(ctx, require("../templates").render("banner_desc_prompt"), menu.withHome([]));
  }
  if (s.awaitingField === "banner_desc") {
    // One clean paragraph, capped: this goes into a channel post whose caption
    // Telegram limits to 1024 characters, shared with the rest of the card.
    bf.description = input === "/skip" ? null : input.replace(/\s+\n/g, "\n").trim().slice(0, 500);
    s.awaitingField = "banner_ca";
    return sendCard(ctx, require("../templates").render("banner_ca_prompt"), menu.withHome([]));
  }
  if (s.awaitingField === "banner_ca") {
    // No chain validation on purpose — an advertiser may be on a chain Dexvra
    // doesn't sell listings for, and this is only ever displayed, never used to
    // look anything up.
    bf.address = input === "/skip" ? null : input.split(/\s+/)[0].slice(0, 120);
    s.awaitingField = "banner_socials";
    return sendCard(ctx, require("../templates").render("banner_socials_prompt"), menu.withHome([]));
  }
  if (s.awaitingField === "banner_socials") {
    if (input !== "/skip") Object.assign(bf, parseSocials(input));
    s.awaitingField = null;
    return showPayMethods(ctx);
  }
}

/**
 * Sort pasted links into X / Telegram / website by host, so the buyer sends ONE
 * message instead of answering three prompts. Anything that isn't X or Telegram
 * is treated as the website — the common case being a bare project URL.
 */
function parseSocials(text) {
  const out = {};
  for (const url of String(text).match(/https?:\/\/\S+/gi) || []) {
    const u = url.replace(/[),.]+$/, "");
    if (/^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(u)) out.twitter = out.twitter || u;
    else if (/^https?:\/\/(www\.)?(t\.me|telegram\.(me|dog))\//i.test(u)) out.telegram = out.telegram || u;
    else out.website = out.website || u;
  }
  return out;
}

async function showPayMethods(ctx) {
  const bf = ctx.session.bannerForm;
  bf.pay = {};
  const rows = [];
  for (const chain of PAY_CHAINS) {
    const q = await usdToNative(chain, bf.usd).catch(() => null);
    if (!q) continue;
    bf.pay[chain] = q;
    rows.push([Markup.button.callback(`${q.human} ${q.native} · ${networkLabel(chain)}`, `bpay_${chain}`)]);
  }
  if (!rows.length) {
    return sendCard(ctx, require("../templates").render("price_feed_down"), menu.withHome([]));
  }
  await sendCard(
    ctx,
    require("../templates").render("banner_pay_prompt", { slot: bf.slot, size: bf.size, duration: bf.duration, usd: bf.usd }),
    menu.withHome(rows),
  );
}

async function payPick(ctx) {
  await answer(ctx);
  const bf = ctx.session && ctx.session.bannerForm;
  if (!bf || !bf.pay) return toast(ctx, require("../templates").render("session_expired"));
  const chain = ctx.match[1];
  const q = bf.pay[chain];
  if (!q) return toast(ctx, "That currency isn't available — pick another.");
  await startPayment(ctx, {
    kind: "banner",
    chain,
    native: nativeOf(chain),
    humanAmount: q.human,
    // This flow picked the network already, so pinning it here keeps the pay
    // card's network line right without offering a second picker on top of the
    // one the buyer just used.
    payChain: chain,
    // The quoted STRING, not Number(q.human): the amount armed here must stay
    // byte-identical to what this flow has always sent. This map exists only so
    // the pay card can name the network.
    prices: { [nativeOf(chain)]: q.human },
    label: `Banner · ${bf.slot} (${bf.size}) · ${bf.duration}`,
    payload: {
      rec: {
        slot: bf.slot,
        size: bf.size,
        linkUrl: bf.linkUrl,
        title: bf.title || undefined,
        description: bf.description || undefined,
        address: bf.address || undefined,
        twitter: bf.twitter || undefined,
        website: bf.website || undefined,
        telegram: bf.telegram || undefined,
      },
      imageFileId: bf.imageFileId,
      hours: bf.hours,
    },
  });
}

// yesNo kept for compatibility with the registry (banner links are optional via
// /skip in the text step, so this is a no-op unless wired to a future step).
async function yesNo(ctx) {
  await answer(ctx);
}

module.exports = {
  parseSocials, entryBanner, typePick, durationPick, payPick, yesNo, handleText, handlePhoto };
