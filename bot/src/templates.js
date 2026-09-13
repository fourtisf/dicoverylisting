// Editable-template engine. Every user-facing message and channel-post layout
// has a built-in DEFAULT here; admins override any of them via @dexvraadminbot,
// which writes data/templates.json. The main bot reads through render(key, vars)
// / t(key, vars), substituting {placeholders}, and auto-refreshes the file every
// 30s so edits apply WITHOUT a redeploy.
//
// Template format — PREMIUM MARKUP (fourtis syntax), not HTML:
//   [😀](emoji/1234567890)  premium custom emoji (😀 = fallback shown to non-premium)
//   **bold**   [text](url)   `code`
// Rendering modes, decided per template:
//   1. Admin pasted a message containing premium emoji → stored {text, entities},
//      re-sent with entities (offset-safe substitution).
//   2. Markup string (all DEFAULTS) → parsed to text+entities.
//   3. Legacy saved HTML (real tags present, no markup) → parse_mode:"HTML".
const path = require("node:path");
const { loadJSONSync, saveJSON, DATA_DIR } = require("./helpers/persist");
const { escapeHtml } = require("./helpers/format");
const premium = require("./premium");

const FILE = "templates.json";
// Swapped icons live SEPARATELY from the templates they decorate. Writing them
// into templates.json meant one emoji swap froze that card's whole layout, so
// every later copy fix silently stopped reaching the server — see
// replaceEmojiAt.
const EMOJI_FILE = "templates.emoji.json";
const BANNER_PATH = path.join(DATA_DIR, "banner"); // image bytes (any ext), set by adminbot
const REFRESH_MS = 30000;

// Premium emoji document IDs. NOTE: these are a THIRD-PARTY (fourtis) pack —
// rendered as custom emoji they show FOURTIS BRANDING inside Dexvra posts
// (operator complaint: the fourtis logo appeared on rank-up alerts). em()
// therefore ALWAYS returns the plain unicode emoji now, regardless of the old
// PREMIUM_EMOJI env flag; the table stays only as documentation. Premium emoji
// enter templates exclusively via the adminbot editor (admins paste their OWN
// pack) and via the per-token logo packs — both unaffected.
const E = {
  rocket: "5341323326188956773", // 🚀
  plane: "5039783602301175152", // ✈️
  globe: "5456437619476941825", // 🌐
  globe2: "5447410659077661506", // 🌐 (alt)
  link: "5271604874419647061", // 🔗
  zap: "5105049474359624797", // ⚡
  zap2: "5456140674028019486", // ⚡️
  chartUp: "5280842756367851322", // 📈
  siren: "5972051363939487192", // 🚨
  sirenHead: "5395695537687123235", // 🚨 (header)
  clip: "5305265301917549162", // 📎
  chart: "5415916918026548824", // 📊
  dollar: "5413400737205990933", // 💲
  green: "6073581319915312172", // 🟢
  megaphone: "5217943819311389632", // 📢
  gold: "5440539497383087970", // 🥇
  diamond: "5427168083074628963", // 💎
  cross: "5454335838575936647", // ❌
};
// `em(char, id)` → the premium-emoji markup this file's header documents:
// "[😀](emoji/1234567890)". It took the id and THREW IT AWAY — the signature
// said (emoji) — so every one of the 34 call sites below rendered the bare
// unicode char and the whole E map above was dead code. Nothing errored, and
// the loss is invisible for a char like 💎 or 🚨 whose unicode art is already
// colourful; it is obvious for 📢, whose premium art is a different picture
// entirely. That is the difference an operator spotted in the channel footer.
//
// Emitting the markup is safe on both transports, and neither needed changing:
// GramJS sends the custom_emoji entities and retries without them on
// PREMIUM_ACCOUNT_REQUIRED / EMOJI_INVALID (gramjs.js isPremiumEmojiError),
// while the Bot API path filters type "custom_emoji" out and shows the fallback
// char (trendingPoster.js). The legacy-HTML render branch cannot swallow it
// either: it is guarded on !hasPremiumMarkup.
const em = (emoji, id) => (id ? `[${emoji}](emoji/${id})` : emoji);

// ── Channel-post building blocks (code-level only, NOT separate templates) ──
// Inlined into every channel-post DEFAULT below so each stored template is the
// FULL post. Editing stays per-template; these constants only keep the code DRY
// and feed the legacy {socials}/{footer} vars for templates saved before the
// one-template-per-post era. Socials sit SIDE-BY-SIDE on one row (" · "
// separated) — channels/format.js cuts a segment whose link the token doesn't
// have, and the whole paragraph when it has none.
const SOCIALS_BLOCK =
  `${em("🔗", E.link)} **{symbol} social links**\n` +
  `${em("❌", E.cross)} [X]({twitter}) · 🌐 [Website]({website}) · ✈️ [Telegram]({telegram})`;
// The site + all three Telegram channels, side by side on ONE row. Split out of
// FOOTER_BLOCK so the short ticker posts (rank-up / pump) carry the SAME set
// without the "📎 Dexvra" header line above it — a reader who lands on any post
// can reach the site and every channel. Never trim it to a SUBSET of these
// four: a pump alert that linked only Trending + Dexvra.io was the operator's
// complaint.
const LINKS_ROW =
  `${em("💎", E.diamond)} [Dexvra.io]({site}) · ` +
  `${em("🚨", E.sirenHead)} [Listings]({listing}) · ` +
  `🔥 [Trending]({trending}) · ` +
  `${em("📢", E.megaphone)} [Announcements]({announce}) · ` +
  `𝕏 [X Alerts]({xlisting})`;
// The row is the full Dexvra destination set — the three Telegram channels, the
// site, AND the X account the listing feed is tweeted from ({xlisting} →
// X_LISTING_URL, @listingdexvra by default — NOT the Telegram @dexvralisting
// channel, which is a different account). X was previously left out on the
// grounds that the token's own social row a few lines above already prints
// "❌ X"; that reads as a duplicate only if you assume both point at the same
// account, which they never do — one is the PROJECT's X, this one is DEXVRA's.
// The row is also rendered header-less on the short rank-up / pump posts, which
// carry no social row at all, so there it was the only X link a reader could
// have followed. The label is what channels/format.js re-links by, so keep the
// words "X Alerts" if you reword the rest of the row.
const FOOTER_BLOCK = `${em("📎", E.clip)} **Dexvra**\n` + LINKS_ROW;
// Shared body of the listing/trending cards (below their distinct headers).
// Clear, labelled stats so a reader sees the token, its market at a glance, and
// exactly where to trade it. {price}/{mcap}/{liq} come from live data.
const LISTING_BODY =
  // ONLY the token name is the clickable link to its Dexvra page — the ({symbol})
  // stays plain text beside it — and no bare dexvra.io/… URL is printed (spam).
  `${em("💲", E.dollar)} [{name}]({coinUrl}) ({symbol})\n\n` +
  `{chainEmoji} **Network:** {chain}\n` +
  `📄 **Contract address:**\n{address}\n\n` +
  // Market cap and Price ONLY, SIDE-BY-SIDE on one line (operator preference) —
  // no liquidity row, and never stacked. ({liq} stays an available placeholder
  // for any custom template that still wants it.)
  `${em("🏦", E.dollar)} **Market cap:** {mcap} · ${em("📊", E.chart)} **Price:** {price}\n\n` +
  // Single one-tap CTA. {tradeUrl} = https://t.me/<tradebot>?start=ca_<address>
  // — the deep link carries the token's CA so the trade bot opens straight on
  // this token (no "Trade it now" header line above it).
  `[⚡ Buy / Sell on Dexvra Trade Bot]({tradeUrl})\n\n` +
  `[Announce On X 𝕏]({xUrl})\n\n` +
  `${SOCIALS_BLOCK}\n\n${FOOTER_BLOCK}`;

// ── Built-in defaults (premium markup) ───────────────────────────────────────
// Placeholders each template accepts are listed in META below (for the editor).
// Voice: professional exchange-style — clear hierarchy, short lines, emoji as
// accents (never bullet spam). Deliberately NOT the fourtis layout.
const DEFAULTS = {
  // ── Bot messages (to the user) ──
  // Channel links are CONFIG-DRIVEN placeholders ({site}/{announce}/{listing}/
  // {trending}) — start.js fills them from CHANNELS/SITE_URL so the default
  // links are always correct. Edit the labels/links freely; keep the
  // [Label]({placeholder}) shape and the link stays clickable.
  welcome:
    "💎 **Welcome to Dexvra**\n\n" +
    "⚡ **List · Trend · Advertise** — your token pushed across [dexvra.io]({site}), our Telegram channels and **X**, fully automatic and live in minutes.\n\n" +
    "**✨ What you can do**\n" +
    "⚡ **Xpress Listing** — live in minutes\n" +
    "🏆 **Listing & Trending** — ranked tiers, Diamond → Bronze\n" +
    "🔥 **Trending Token** — featured, up to 48H\n" +
    "📢 **Banner Ads** — homepage campaigns\n" +
    "🚀 **Mass DM** — reach every Dexvra user\n" +
    "🟢 **Buy Bot** — free live buy alerts for your group\n\n" +
    "**🔗 Official Links**\n" +
    "🌐 [Website]({site})\n" +
    "📢 [Announcements Channel]({announce})\n" +
    "🚨 [Listings Channel]({listing})\n" +
    "📈 [Trending Channel]({trending})\n" +
    "❌ [Listing Alerts on X]({xlisting})\n\n" +
    "👇 Pick a service below — each step is fully guided.",
  intro_xpress:
    "⚡ **Xpress Listing**\n\n" +
    "🔹 Go live in **minutes** — no tier, no review.\n\n" +
    "**What you get**\n" +
    "✅ Listed on [dexvra.io](https://dexvra.io)\n" +
    "🚨 Launch post on Telegram — [@dexvralisting](https://t.me/dexvralisting)\n" +
    "𝕏 Automatic post on X — [@listingdexvra]({xlisting})\n\n" +
    "💎 Want Trending + a tier badge too? Choose **🏆 Listing & Trending**.\n\n" +
    "🔹 Only one step away — **select your network** below to begin:",
  intro_tiered:
    "🏆 **Listing & Trending**  (Best value)\n\n" +
    "🔹 Maximum exposure across the entire Dexvra network.\n\n" +
    "**What you get**\n" +
    "✅ Permanent listing on [dexvra.io](https://dexvra.io)\n" +
    "🚨 Launch post on Telegram — [@dexvralisting](https://t.me/dexvralisting)\n" +
    "🔥 Featured Trending run on [@dexvratrending](https://t.me/dexvratrending)\n" +
    "📢 Announcement headline on [@dexvraio](https://t.me/dexvraio) (top tiers)\n" +
    "𝕏 Automatic post on X — [@listingdexvra]({xlisting})\n" +
    "💎 A ranked tier badge on every post\n\n" +
    "⚠️ Only **Diamond, Gold & Platinum** get the bonus @dexvraio announcement.\n\n" +
    "🔹 Only one step away — **select your network** below to begin:",
  tier_chooser:
    "🏆 **Select your tier**\n\n" +
    "🔹 **Every tier includes:** a permanent dexvra.io listing, a launch post on @dexvralisting, a bundled Trending run, an automatic X post and a tier badge.\n\n" +
    "💎 **Higher tiers** rank higher and trend longer — and Diamond, Gold & Platinum add a headline on @dexvraio.\n\n" +
    "🔥 Only one step away — choose your tier (prices in **{native}**):",
  trending_durations:
    "🔥 **Trending — {symbol}** · {chain}\n\n" +
    "🔹 A featured slot on the dexvra.io Trending board, announced instantly on [@dexvratrending](https://t.me/dexvratrending).\n\n" +
    "📢 **24H & 48H** runs also get a headline on [@dexvraio](https://t.me/dexvraio).\n" +
    "💰 Longer durations carry bigger discounts.\n\n" +
    "🔥 Only one step away — select a duration (**{native}**):",
  intro_banner:
    "📢 **Dexvra Banner Ads**\n\n" +
    "🔹 Your creative on the dexvra.io homepage — seen by every visitor.\n\n" +
    "**What you get**\n" +
    "🖼 A homepage banner with your own click-through link\n" +
    "📢 An announcement on [@dexvraio](https://t.me/dexvraio)\n" +
    "𝕏 An automatic post on X — [@listingdexvra]({xlisting})\n\n" +
    "💰 USD pricing — bigger discounts on longer runs.\n\n" +
    "🔹 Please have your banner ready (GIF, JPG or PNG). Choose a format:",
  listing_ca_prompt:
    "📄 **Contract Address**\n\n🔹 Paste your token's contract address on **{chain}**:",
  listing_lookup_wait:
    "🔎 **Reading your token's profile…**\n\n" +
    "🔹 Pulling the name, logo and socials from the indexers — a few seconds.",
  flow_step_failed:
    "⚠️ **That didn't go through**\n\n" +
    "🔹 Something went wrong on our side handling your last message — please send it again.",
  listing_name_prompt: "🪙 **Token Name**\n\n🔹 What is your project called?",
  listing_symbol_prompt: "💠 **Ticker**\n\n🔹 Send your token symbol (e.g. PEPE):",
  listing_logo_prompt: "🖼 **Logo**\n\n🔹 Send your logo as a photo — or /skip to continue without one.",
  trending_ca_prompt:
    "🔥 **Book a Trending Slot**\n\n" +
    "🔹 Push your listed token to the top of the dexvra.io Trending board — in front of the whole network.\n\n" +
    "**What you get**\n" +
    "🔝 Featured placement on the Trending board\n" +
    "🔥 Instant activation alert on [@dexvratrending](https://t.me/dexvratrending)\n" +
    "📢 24H & 48H runs also headline on [@dexvraio](https://t.me/dexvraio)\n" +
    "𝕏 An automatic post on X — [@listingdexvra]({xlisting})\n\n" +
    "⌛ Slots run up to **48 hours** — longer runs carry bigger discounts.\n\n" +
    "🔹 Paste the **contract address** of your listed token (or its dexvra.io link):",
  // One token, one listing. Shown whenever a contract that is already on the
  // site is submitted again — in the listing form, or just pasted into the chat.
  // It has to answer "so what now?", hence Book Trending as the next step.
  already_listed:
    "✅ **{name} (${symbol})** is already listed on [dexvra.io]({site})!\n\n" +
    "🔗 **View your token**\n" +
    "{url}\n\n" +
    "📊 **Chain:** {chain}\n\n" +
    "🔹 A contract can only be listed once — it is already live on the site.\n\n" +
    "📈 **Want more eyes on it?**\n\n" +
    "💡 Tap **🔥 Book Trending** below to push it to the top of the board.\n\n" +
    "𝕏 Every Dexvra listing is announced on X — [{xlisting}]({xlisting})",
  trending_not_found:
    "❌ **Not listed yet**\n\n" +
    "🔹 We couldn't find that token on Dexvra.\n\n" +
    "List it first — ⚡ **Xpress** or 🏆 **Listing & Trending** — then come back to book your Trending slot.",
  review_card:
    "📋 **Review your listing**\n\n" +
    "🪙 **Token:** {name} ({symbol})\n" +
    "📊 **Chain:** {chain}\n" +
    "📂 **Contract:**\n`{address}`{bonding}\n\n" +
    "🖼 **Logo:** {logo}\n\n" +
    "💬 **Overview:**\n{overview}\n\n" +
    "🌐 **Website:** {website}\n\n" +
    "🐦 **X:** {twitter}\n\n" +
    "📢 **Telegram:** {telegram}\n\n" +
    "🔹 This is exactly what goes live on your token page and channel posts.\n\n" +
    "Tap **✅ Confirm**, or use the edit buttons below.",
  edit_field_prompt: "✏️ Send the new **{field}**:",
  invalid_address:
    "❌ That doesn't look like a valid **{chain}** contract address.\n\n🔹 Double-check and paste it again:",
  invalid_url: "❌ That must be a full **https://** URL.\n\n🔹 Please try again:",
  // The site's rule, said in the user's words (see helpers/ticker.js).
  invalid_ticker:
    "❌ That ticker can't be used — letters and numbers only (`.` `_` `-` are fine), " +
    "up to 24 characters, no spaces or emoji.\n\n🔹 Send the ticker again (e.g. **PEPE**):",
  listing_incomplete: "⚠️ Please set a **name, symbol and a valid contract address** before confirming.",
  pricing_unavailable: "⚠️ Pricing isn't available for this network yet — please pick another.",
  session_expired: "⌛ Your session expired — send /start to begin again.",
  // Sent when a handler throws or times out, so a failure is never just silence.
  error_retry: "⚠️ Something went wrong on our side — nothing was charged.\n\n🔹 Please try that again, or send /start to begin fresh.",
  trending_service_down: "⚠️ We couldn't reach the listings service — please try again in a moment.",
  banner_duration_prompt:
    "📢 **{name}** · {size}\n\n" +
    "🔹 Campaign pricing is in **USD**, converted to crypto at checkout.\n" +
    "💰 Longer runs carry bigger discounts.\n\n" +
    "🔹 Choose your campaign duration:",
  banner_image_prompt:
    "🖼 **Upload your creative**\n\n" +
    "🔹 Send your banner as a **photo** — PNG or JPG, clean and readable at a glance.\n\n" +
    "📐 **Exact size: {size}** (or any image with the same shape — {size2x} is ideal for a sharp result).\n" +
    "🔹 This exact shape is used **both** on the dexvra.io homepage and in the announcement post, so a banner at this size is never cropped.",
  banner_link_prompt:
    "🔗 **Target Link**\n\n🔹 Send the **click-through URL** (https://…) — visitors who tap your banner land here:",
  banner_desc_prompt:
    "📝 **Description**\n\n" +
    "🔹 Send the text you want under your banner in the announcement — what the project does, in your own words.\n\n" +
    "Send **/skip** to leave it out.",
  banner_ca_prompt:
    "📄 **Contract Address**\n\n" +
    "🔹 Paste your token's contract address — it will be shown as copyable text under your description.\n\n" +
    "Send **/skip** if your campaign has no token.",
  banner_socials_prompt:
    "🔗 **Socials**\n\n" +
    "🔹 Paste your links in ONE message — **X**, **Telegram** and **Website** (any order, one per line is fine).\n\n" +
    "Send **/skip** to leave them out.",
  banner_title_prompt:
    "🏷 **Campaign Title**\n\n🔹 Send a short title for your campaign (shown in the announcement) — or /skip:",
  banner_pay_prompt:
    "💳 **{slot}** · `{size}` · {duration} — **${usd}**\n\n" +
    "🔹 Choose the currency you'd like to pay with — the exact amount is calculated at the live market rate:",
  price_feed_down: "⚠️ The price feed is unavailable right now — please try again in a minute.",
  checking_payment:
    "🌀 **Verifying your payment…**\n\n" +
    "🔹 Detecting **{amount} {native}** on **{chain}** — on-chain confirmation usually takes 30–60 seconds. We'll confirm here automatically.",
  still_checking: "⏳ Still verifying your last payment — hang tight, this takes up to a minute.",
  no_pending_payment: "🔹 There's no pending payment on this chat. Send /start to begin.",
  pay_card:
    "⚡ **Order Summary**\n\n" +
    "{label}\n\n" +
    "👜 **Send {native} to this wallet:**\n`{address}`\n\n" +
    "🔗 **Network: {network}** — send on this network only.\n\n" +
    "💰 **Amount:** `{amount}` {native}\n\n" +
    "⏳ This address is unique to your order. **Please pay within 5 minutes**, then tap **✅ Confirm Payment** — verification usually takes under a minute.",
  // The buyer chooses which network settles the order. ETH is the same price on
  // both — this is a choice of RAIL, not of price, and saying so is what stops
  // "which one is cheaper?" being the next question.
  pay_pick:
    "💳 **Choose how to pay**\n\n" +
    "{label}\n\n" +
    "🔹 Pick the network you'll send from. The amount is shown on each button.\n" +
    "🔹 **ETH costs the same on Ethereum and on Robinhood Chain** — Robinhood confirms in seconds with far lower fees.\n\n" +
    "⚠️ Send only on the network you pick. A transfer on any other network cannot be credited automatically.",
  pay_card_admin:
    "🧪 **Admin Test Order — FREE**\n\n{label}\n\n🔹 No payment needed. Tap **✅ Confirm** to run the flow end-to-end.",
  // ── The broadcast add-on's line on the pay card ───────────────────────────
  //
  // "saya tidak [ada] bot message tentang broadcast" — reported by an operator
  // looking through 📝 Templates for the sentence they can see on the pay card.
  // It was not there: the line was built from a STRING inside pay.js, so it was
  // the one buyer-facing broadcast message in the bot that could be neither
  // edited nor given a premium emoji, on the card that takes the money.
  //
  // ⚠️ THEY ARE TWO TEMPLATES BECAUSE THEY CARRY DIFFERENT FACTS, and folding
  // them into one with a "{fee}" that renders empty would put the whole weight
  // on an operator remembering why. A paid card names the FEE — that is what
  // explains a number bigger than the tier the buyer picked. An admin card
  // quotes no price anywhere ("No payment needed"), so with no fee to name,
  // nothing at all would say this DM is REAL: it queues against the whole
  // /start audience with no review, and it is not the 🧪 Test send.
  //
  // ⚠️ THE ROW IS APPENDED, NEVER A PLACEHOLDER ON pay_card. Whether the add-on
  // is attached is a fact about the ORDER, not about the card, and an operator
  // who saved pay_card before the add-on existed keeps their copy for ever —
  // so appending is the mechanism here rather than a fallback.
  pay_card_broadcast: "📣 **Includes a Mass DM Broadcast to all users (+{fee})**.",
  pay_card_broadcast_admin:
    "📣 **Includes a Mass DM Broadcast — it really goes out to every bot user, not a test send**.",
  payment_not_detected:
    "❌ **Payment not detected yet**\n\n" +
    "🔹 We haven't seen your transfer of **{amount} {native}** to:\n`{address}`\n\n" +
    "🔹 Just sent it? Give it a minute and tap **Confirm** again.\n" +
    "🔹 Already paid? Contact support with order ID `{order}`.",
  payment_snag:
    "⚠️ **We're on it**\n\n🔹 Your payment for order `{order}` arrived, but finalizing hit a snag. Your funds are safe — contact support and we'll complete your order.",
  // A pay card outlives the payment it was made for: the watcher that credits a
  // late transfer runs after the handler returned, so it cannot clear the card
  // from the session. Without this, a second tap re-reads a wallet that has been
  // SWEPT and answers "payment not detected" about an order already paid for.
  payment_already_credited:
    "✅ **Already received**\n\n🔹 Order `{order}` is paid — there's nothing left to confirm. Your receipt is posted here the moment it's ready.",
  // Receipt shape follows the reference bot the operator asked for: one congrats
  // line, the token's page as a BARE url, then one line per post that went out.
  // Each destination is its OWN line with its OWN label, so the operator can
  // reword or reorder them — a single auto-generated {postLinks} blob could not
  // be edited at all. A line whose link doesn't exist (an Xpress buyer has no
  // announcement and no trending post) disappears completely; see
  // dropEmptyLines. {postLinks}/{announceX} still work for older saved copies.
  success_listing:
    "✅ **Payment Confirmed**\n\n" +
    "⚡ Congrats! Your token **{name}** ({symbol}) is officially listed!\n" +
    "{siteUrl}\n\n" +
    "🔔 Dexvra Listing: {listingUrl}\n" +
    "🔔 Dexvra Listing (X): {xUrl}",
  // Listing & Trending buys three things at once — the listing, a ranked tier
  // badge and a timed Trending run — so the second line accounts for the two a
  // buyer cannot read off the links. {tier}/{tierEmoji}/{hours} exist only here.
  success_listing_tiered:
    "✅ **Payment Confirmed**\n\n" +
    "🏆 Congrats! Your token **{name}** ({symbol}) is officially listed!\n" +
    "{tierEmoji} **{tier}** tier · 🔥 Trending for **{hours}h**\n" +
    "{siteUrl}\n\n" +
    "🔔 Dexvra Listing: {listingUrl}\n" +
    "🔔 Dexvra Listing (X): {xUrl}\n" +
    "🔔 Dexvra Announcement: {announceUrl}\n" +
    "🔔 Dexvra Trending: {trendingUrl}",
  success_trending:
    "✅ **Payment Confirmed**\n\n" +
    "🔥 Congrats! **{symbol}** is Trending on Dexvra for the next **{hours}h**!\n" +
    "{siteUrl}\n\n" +
    "🔔 Dexvra Trending: {trendingUrl}\n" +
    "🔔 Dexvra Announcement: {announceUrl}\n" +
    "🔔 Dexvra (X): {xUrl}",
  success_banner:
    "✅ **Payment Confirmed**\n\n" +
    // No "banner" after {slot} — every slot name already ends in "Banner".
    "⚡ Your **{slot}** is booked on the dexvra.io homepage.\n\n" +
    "🗓 **Runs:** {startsAt} → {endsAt}\n" +
    "{queueNote}\n{postLinks}\n{announceX}\n\n" +
    "🌐 [dexvra.io]({site})  |  🚨 [Listing]({listing})  |  🔥 [Trending]({trending})  |  📢 [Announcement]({announce})",
  // ── The moment the bot lands in a group ─────────────────────────────────
  // Posted from the my_chat_member update, BEFORE anyone types anything. It
  // asks for the permissions the bot actually uses and then stops: a group that
  // has just added a bot wants to know what to grant it, not to read a feature
  // list. The full setup steps are /start (group_start below).
  //
  // NOT the "👋 Thanks for adding me! ‼️ … 🚀 Then type /start" card every other
  // group bot posts — Dexvra reads as a clone the moment it borrows that, which
  // is the same reason group_buy_alert refuses the copy-trading bots' layout.
  //
  // Each permission SAYS WHAT IT IS FOR, and that is the substantive difference,
  // not the wording: a bare list of three powerful rights reads as a bot asking
  // for the keys to the group, and an admin is right to hesitate. Every one
  // named here is a right the code genuinely exercises — ask for more than you
  // use and refusing all of it is the correct response.
  group_added:
    "🟢 **Dexvra is in**\n\n" +
    "Make it admin and it starts calling every buy in here.\n\n" +
    "📌 **Pin messages** — whale buys and the live raid board\n" +
    "🗑 **Delete messages** — clears the raid panel when it ends\n" +
    "🚫 **Ban users** — only if you switch on the raid chat lock\n\n" +
    "**Group Settings → Administrators**, then tap 🤖 Buy Bot below.\n",
  // The setup guide, sent on /start in a group — the message straight after
  // group_added. Same voice as that one: section headers, one line of what it
  // does, then the commands. It used to be written in the first person ("make
  // me an admin", "DM me", "I keep a scoreboard"), which reads as a different
  // product to the card above it.
  // THE BUTTONS ARE THE INSTRUCTIONS. This card used to end each section with
  // its command — "/settoken <CA> to arm it · /setminbuy 50 · /buybot off" —
  // which is syntax aimed at somebody who has just added a bot and is looking
  // for something to press, not something to read. Every command still works;
  // none of them is what a new group should have to find. See
  // handlers/start.js groupStartKeyboard() for the keyboard sent with this.
  //
  // So keep this text about WHAT EACH THING DOES. Adding a command back here
  // does not make the card more helpful, it makes the buttons look optional.
  group_start:
    "🟢 **Dexvra — free tools for your group**\n\n" +
    "**🤖 Buy Bot** — every on-chain buy called in here the second it lands: size, price, mcap, the wallet, and the txn to prove it. Tap below and paste your contract; that is the whole setup.\n\n" +
    "**🐋 Whale wallets** — when a wallet already deep in your bags adds more, that one gets **pinned**. On by default, tune it in ⚙️ Settings.\n\n" +
    "**🚀 Raid** — point the chat at one post and keep the board pinned until the numbers hit. No X key needed — 🤝 Crew counts whoever shows up.",
  // Button labels for the card above, pipe separated:
  //   buy bot | raid | settings | listing/trending | channel
  // Field-by-field fallback, so a half-typed override still renders a keyboard
  // instead of a row of blanks. The last two are LINK buttons and are dropped
  // when SITE_URL / the announce channel are not set to something Telegram will
  // accept — it rejects the whole message over one malformed URL.
  group_start_buttons: "🤖 Buy Bot|🚀 Raid|⚙️ Settings|🔥 Listing / Trending|📢 Channel",
  buybot_help:
    `${em("🟢", E.green)} **Group tools — free for your project**\n\n` +
    "Add @dexvrabot to your Telegram group and you get both of these, no charge:\n\n" +
    "**🤖 Buy Bot**\n" +
    "A live alert on **every on-chain buy** of your token — amount, price, market cap, price impact, plus a link to the real transaction and the buyer's wallet.\n" +
    "1. Tap **➕ Add to your group** below and pick your group\n" +
    "2. Make the bot an **admin** (so it can post)\n" +
    "3. In the group send /settoken <your contract address>\n" +
    "4. Tune with /setminbuy <usd>, pause with /buybot off\n\n" +
    "**🐋 Whale wallets** — a buy from a wallet already holding a lot of your token gets its own alert, **pinned** in the group so nobody misses it. Set the bar with /setwhale 50000.\n\n" +
    "**🚀 Raid**\n" +
    "Point your community at one X post and watch the numbers climb on a live card. Set the targets (**+15 likes**, **+5 replies**, **+10 crew**), paste the link, launch. Optionally lock the chat until the targets are hit.\n" +
    "In the group, send /raid.\n\n" +
    "Works on Solana, BSC, Ethereum, Base, Tron, TON, Sui, Plasma & Robinhood.\n\n" +
    "𝕏 Every listing is announced on X too — [Listing Alerts]({xlisting})",
  // THE REAL ALERT — one verified transaction, one card. Every number here
  // comes from the trade itself or the pool it happened in, so a reader can
  // open {verify} and check it. Do NOT add a placeholder to this template that
  // the estimated path cannot fill; the two are separate templates precisely so
  // neither has to pretend.
  // THE ICON COLUMN. One emoji per row, at the left edge, and the value
  // straight after it — the grammar every trader already reads on the buy bots
  // they follow, and what the operator asked for by name.
  //
  // This REPLACED a bold-label layout ("**Spent:** …") chosen deliberately to
  // look unlike those bots. The reasoning then was that stacked emoji are
  // decoration the eye has to skip past to reach the labels. In a group feed
  // that turned out to be backwards: the icon IS the label, it is scannable at
  // a glance while scrolling, and it costs no line width — which matters on a
  // phone, where a bold label pushes the number that people actually came for
  // onto a second line. Standing out was never worth being harder to read.
  //
  // If you are reverting this, revert group_whale_alert with it: the two are
  // one grammar, and a feed that mixes two reads as a bug in the bot rather
  // than a choice.
  //
  // {emoji} is the size row (see group_buy_style); {bar} is a fill-meter, still
  // available as a placeholder if you ever want one.
  // NO MARK AND NO PIPE IN FRONT OF THE NAME. The header used to open
  // "💎 | {name} BUY!" — the Dexvra diamond, then a separator whose only job was
  // to hold the diamond apart from the name. The token's own name is what a
  // reader is scanning for, and putting our badge in front of it every time
  // spends the most valuable character position on the card telling them
  // something they already know. Dropping the emoji drops the pipe with it: a
  // separator with nothing on its left is punctuation for a word that is not
  // there.
  group_buy_alert:
    "{intro}[{name}]({coinUrl}) **{tier}!**{poweredBy}\n" +
    "{emoji}\n\n" +
    "{nameRow}\n" +
    "💲 {usd}{native}\n" +
    "🪙 {tokenAmt} {symbol}\n" +
    // Price and market cap, the two numbers that say whether this buy is a
    // rounding error or a dent.
    //
    // THE LIQUIDITY / 24h ROW IS GONE, and {liq} and {change} are placeholders
    // now rather than a shipped row. Put "💧 {liq} · 24h {change}" back on a line
    // of its own if you want it. It was the row a reader's eye skipped: pool
    // depth is a property of the token that has not changed since the last alert
    // and will not change by the next, so repeating it under every buy spent a
    // line restating the background instead of reporting the event.
    "📊 {price} · MC {mcap}\n" +
    "{verify}\n" +
    // The buyer's own position, directly under WHO bought — how much of the
    // token that wallet now holds, what it is worth, and how much this buy grew
    // it. {wallet} is the WHOLE row (emoji and label included) so it VANISHES
    // rather than leaving a dangling label whenever the holding could not be
    // read: an unsupported chain, an RPC that did not answer, a buy under the
    // dust floor, or a group that turned holdings off with /setwhale off.
    // {holds}, {holdsUsd} and {position} are the same three facts on their own
    // if you would rather lay them out yourself.
    "{wallet}\n\n" +
    // The icons sit OUTSIDE the link labels. Telegram will not render a bot's
    // custom emoji inside a text_link — proven on a live card where every other
    // icon animated and exactly these three stayed fallback chars — so an icon
    // inside the label is an icon a 💎 swap can never light up. Outside, it is
    // an ordinary top-level emoji: swappable, animatable, same look.
    "⚡ [Trade on Dexvra]({tradeUrl}) · 📈 [Chart]({chartUrl}) · 💎 [Dexvra]({coinUrl})",
  // WHALE WALLET — a buy from someone already holding a lot of the token,
  // whatever they just spent. Pinned in the group, so it is deliberately its own
  // card rather than the normal one with a louder word on it.
  //
  // {holds} is the buyer's balance OF THIS TOKEN valued at the pool price — not
  // a portfolio total, which this bot cannot see. The label says so.
  //
  // {whaleBar} — the bar this wallet cleared — is a PLACEHOLDER, not a default
  // row. It is the operator's own threshold, and a reader in the group has no
  // use for it: it explains the bot's mechanism instead of reporting the event.
  // Available for anyone who does want it, and never a hardcoded "$50,000",
  // because the group's /setwhale or the admin bot can move it at any time.
  // THE SAME BODY AS THE BUY CARD, ROW FOR ROW. Only the banner and the header
  // word differ, and that is the entire point: these two land in the same chat
  // minutes apart, and a reader who has to re-learn where the price sits reads
  // the difference as a bug rather than as emphasis.
  //
  // The Position row used to sit ABOVE the price here — the holding IS the news
  // on a whale alert, so leading with it was defensible in isolation. It was not
  // defensible next to the other card: two layouts, one feed. The whale card is
  // already louder by its banner, its icon row and its pin; it does not also
  // need its own row order.
  group_whale_alert:
    "{introWhale}[{name}]({coinUrl}) **WHALE WALLET!**{poweredBy}\n" +
    "{emoji}\n\n" +
    "{nameRow}\n" +
    "💲 {usd}{native}\n" +
    "🪙 {tokenAmt} {symbol}\n" +
    "📊 {price} · MC {mcap}\n" +
    "{verify}\n" +
    // {wallet} — the SAME group_position_row the ordinary card renders, in the
    // same place. It used to be spelled out inline here, which is how the two
    // cards drifted: the buy card gained a linked "· Wallet" and the whale card,
    // the one where the holding IS the news, silently did not. One row, one
    // template, one place to edit it.
    "{wallet}\n\n" +
    // Icons outside the labels for the same reason as the buy card's row above.
    "⚡ [Trade on Dexvra]({tradeUrl}) · 📈 [Chart]({chartUrl}) · 💎 [Dexvra]({coinUrl})",
  // The icons in the size row, pipe separated: normal buy | whale wallet.
  // One icon per BUYBOT_EMOJI_STEP_USD, floored and capped, so the row only
  // ever GROWS with the buy.
  //
  // It is a row and not a fill-meter on purpose: a meter shows how much is
  // MISSING, and "▰▱▱▱▱▱▱▱▱▱" on a real buy reads as something failing rather
  // than something good happening. A buy alert should never render mostly empty.
  //
  // PLAIN UNICODE ONLY — this string is split apart and repeated as plain text,
  // so it cannot carry premium-emoji entities. Same rule as raid_style.
  group_buy_style: "🟢|🐋",
  // THERE IS NO "ESTIMATED BUY" TEMPLATE ANY MORE, and this note is here so
  // nobody adds one back. It existed for when the per-transaction feed was
  // unreadable: it diffed the pool's rolling 24h volume, said "≈ $340 across 11
  // buys", and carried a line apologising for having no transaction to link.
  //
  // A buy alert's whole claim is "this happened, here is the proof". Without
  // the proof it is a number a project's own chat cannot check, posted under
  // their ticker — and it was actively costing them the real alerts, because
  // the estimate suppressed every verifiable buy it had already summarised.
  // Silence plus an hourly operator warning is the better failure: the feed
  // coming back replays those buys individually, each with its hash.
  //
  // A group that saved an override for the old `group_buy_alert_est` key keeps
  // a harmless orphan entry in data/templates.json; nothing reads it.
  // The banner line and the byline. BOTH SIT ON THE OPENING LINE — the byline
  // rides at the END of the header, not at the foot of the card. It spent a
  // while down under the CTA row, where it was the last thing a reader reached
  // and the first thing a screenshot cropped off; the point of a byline is to
  // be seen next to the event it is vouching for. Both are WHOLE ROWS: clear
  // either one in @dexvraadminbot and it vanishes cleanly rather than leaving a
  // blank line behind.
  //
  // ONE OPENING LINE: banner, token, event, byline. It used to be three
  // separate blocks stacked down the card, which pushed the numbers people
  // actually came for further off the first screen on a phone for no gain.
  //
  // SELF-SPACING, all of them. dropEmptyLines is opt-in and these cards do not
  // use it, so an empty placeholder would leave its separator behind — clearing
  // the banner would open the card on a stray space. The banner carries its own
  // trailing space and the byline its own leading one, and both sit on a line
  // with other content, so an empty one leaves nothing at all. Same pattern as
  // {socials}/{overview} in the channel posts.
  //
  // {poweredBy} carries the channel handle from config, not a literal — change
  // LISTING_CHANNEL in .env and the byline follows instead of going stale. A
  // bare @handle is deliberate: Telegram links it by itself, and putting one
  // inside a [text](url) target is what made an earlier card fail to send at
  // all ("400: Wrong HTTP URL").
  group_buy_intro: "🚨 **NEW BUY ALERT**",
  // Just the mark. The header already ends "**WHALE WALLET!**", so an intro
  // announcing "WHALE ALERT" printed the word twice in one line — the operator
  // read it as clutter, and they were right. The buy intro keeps its words
  // because its tier ("BUY!") does not repeat them.
  group_whale_intro: "🐋",
  group_powered_by: "| Powered by {listingChannel}",
  // The token row and the buyer row. Both were built in CODE, with their emoji
  // written into buyMonitor.js — so 📃 and 👤 were the only two icons on the
  // card that the "😀 Swap emoji" editor could not reach, and an operator
  // swapping the rest would be left with two that would not change. Same gap
  // the Position row had.
  //
  // {label} and {buyer}/{txn} stay prebuilt in code because what they collapse
  // to is LOGIC, not copy: the token row falls back to the ticker alone when no
  // name resolved, and the buyer row drops either half that has no explorer
  // link. The emoji, the spacing and the separator are copy, and live here.
  //
  // THE TOKEN ROW LEADS WITH ITS NETWORK'S OWN GLYPH, not a fixed 📃. {chainEmoji}
  // comes from the `chain_emojis` template below, picked from the token's chain
  // with nothing for a group to configure — a Solana buy opens with the Solana
  // mark, a Base buy with Base's, and an unknown chain with 💠. That map takes
  // PREMIUM custom emoji, so pasting the real network logos there lights up
  // every buy card on that network at once. Still a placeholder like any other:
  // put 📃 back in front of it if you want both.
  group_name_row: "{chainEmoji} {label}",
  group_buyer_row: "👤 {buyer}{txn}",
  // The 💼 Position row, for the ORDINARY buy card.
  //
  // It used to be built in code and injected as {wallet}, which made it the one
  // row on the card an admin could not reword — while the whale card spelled
  // the same row out in its own template and could. Same row, two rules, and
  // the difference was invisible until somebody went looking for it.
  //
  // The WHOLE row lives here, emoji and label included, so it disappears
  // entirely when the holding could not be read: an unsupported chain, an RPC
  // that did not answer, a buy under the dust floor, or a group that turned
  // holdings off. A label with nothing after it is not a row, it is a
  // rendering bug.
  group_position_row: "✅ Position: {holds} {symbol} · {holdsUsd} ({position}){wallet}",
  // Buy-size tier labels, pipe separated: normal|whale|mega. Thresholds are
  // BUYBOT_WHALE_USD / BUYBOT_MEGA_USD in .env. Missing fields fall back one at
  // a time, so a half-typed override still renders a card.
  //
  // The header reads "{name} {tier}!", so these are the words that finish that
  // sentence — "BUY!", not "NEW BUY!". The old set was written for a header
  // that led with the tier and named the token after it.
  group_buy_tiers: "BUY|WHALE BUY|MEGA BUY",

  // ── Setup replies, /settoken → /buybot ──────────────────────────────────
  // Every one of these is a message a PAYING PROJECT sees inside their own
  // group while wiring the bot up, which is exactly the copy an operator wants
  // to be able to reword — so none of it is hardcoded any more.
  //
  // These render through the same premium-markup parser as everything else:
  // **bold**, `code`, [text](url). NOT HTML tags.
  setup_admin_only: "🔒 Group admins only.",
  setup_group_only: "👥 This one runs in your group. Add the bot there first.",
  // Sent with force_reply, so the member's keyboard opens already replying to
  // it. Keep it short: it sits directly above their input box.
  settoken_prompt:
    "📄 **Paste your contract address**\n\n" +
    "Reply to this message with it. The network is detected from the address — no need to name it.",
  settoken_resolving: "🔎 Finding the pool…",
  settoken_not_found:
    "❌ **No live pool on that CA**\n\n" +
    "Check the address, or name the chain first with /setchain <chain> and run /settoken again.",
  // ⚠️ NOT "no pool" — a read we could not FINISH says nothing about the token.
  // Pool discovery probes every candidate chain serially through the shared
  // GeckoTerminal queue, so on a busy box it can outlast anyone's patience;
  // reporting that as "no live pool on that CA" sends an admin off to check an
  // address that is perfectly fine.
  settoken_resolve_slow:
    "⏳ **Still looking — we ran out of time.**\n\n" +
    "That says nothing about your token: the market-data queue is busy right now. Run /settoken again in a minute, or name the chain first with /setchain to narrow the search.",
  // The token is set and the bot is LIVE — so this says what is already running,
  // not what to run next. It used to end on a row of three commands, which reads
  // as homework at the exact moment the setup finished.
  // The receipt for /settoken. Same icon column as the buy cards, so the first
  // thing a group sees from this bot and every alert after it read as one
  // product — and it ECHOES THE CA. That is not decoration: the address was
  // pasted from somewhere else moments ago, and a group that is about to run
  // alerts on it should be able to check the bot heard the right one before the
  // first buy lands, not after.
  //
  // {links} is the whole "Links:" row, so it VANISHES when a token has no
  // socials rather than leaving a dangling label. {website} {twitter}
  // {telegram} are the same three on their own if you would rather lay them out
  // yourself; each is empty when that link was not found.
  // {chainEmoji} is the NETWORK'S OWN mark, from the same `chain_emojis`
  // template the buy cards and the channel posts read — so a Solana token
  // leads with Solana's, a Robinhood token with Robinhood's, and a PREMIUM
  // emoji pasted there animates here too. A fixed 🔗 said "chain" to a reader
  // who could already see the word Chain next to it, and spent the one
  // position on the row that could have carried the network's identity.
  settoken_ok:
    "✅ **Live on {chain}**\n\n" +
    "{nameRow}\n" +
    "{chainEmoji} Chain: {chain}\n" +
    "💎 CA: `{address}`\n" +
    "{links}\n\n" +
    "🚀 Buy alerts are live. Every buy from **{minBuy}** up gets called in here, and a buyer already holding **{whale}** or more gets pinned.\n\n" +
    "That's everything — the ⚙️ button changes any of it.",
  setchain_unknown: "❌ Not a chain we run on.\n\nOne of: `{chains}`",
  setchain_need_token: "📄 Set the token first: /settoken <contract address>",
  setchain_ok: "✅ Chain set to **{chain}** — pool found.",
  setchain_ok_nopool: "⚠️ Chain set to **{chain}** — no pool yet. It keeps looking every cycle.",
  // Sent when /setminbuy arrives with no amount — a question, so it answers with
  // a picker (the preset buttons come from setup.js) instead of a syntax note.
  setminbuy_panel:
    "💲 **Minimum buy**\n\n" +
    "Buys smaller than this stay out of the chat, so the feed only carries what's worth reacting to.\n\n" +
    "**Now:** {usd}\n\n" +
    "Tap an amount below, or name your own: /setminbuy 250",
  setminbuy_usage:
    "💲 **Minimum buy**\n\n" +
    "That isn't an amount. Send /setminbuy 50 — or just /setminbuy to pick from a list.",
  setminbuy_ok: "✅ **Minimum buy — {usd}**\n\nAnything smaller stays out of the chat.",
  // Sent when the amount asked for is under the $10 floor. Not a refusal: the
  // floor is applied and the reason given, because "call every buy" fills a
  // chat with dust and makes the project's own token look dead.
  setminbuy_min: "✅ **Minimum buy — {usd}**\n\nThat's the lowest floor — under it the feed is mostly dust.",
  // Button toast. Plain text by design: Telegram shows a callback answer as a
  // bare toast, so bold and links in here would reach the tapper as literals.
  setminbuy_toast: "Minimum buy: {usd}",
  // The 🐋 picker, opened by a bare /setwhale or the settings hub. {unsupported}
  // is the same caveat the confirmation carries — a bar on a chain whose
  // balances cannot be read never fires, and the panel must say so.
  setwhale_panel:
    "🐋 **Whale bar**\n\n" +
    "A buy from a wallet **already holding** this much of your token gets its own alert, pinned in the group — however small the buy itself is.\n\n" +
    "**Now:** {usd}\n\n" +
    "Tap a bar below, or name your own: /setwhale 75000{unsupported}",
  setwhale_toast: "Whale bar: {usd}",
  // One word, used wherever a setting has to be shown as off. Its own template
  // so the picker, the toast and the status card cannot drift apart.
  setwhale_state_off: "off",
  setwhale_usage:
    "🐋 **Whale bar**\n\n" +
    "/setwhale 50000 — anyone **already sitting on** that much of your token gets a pinned 🐋 **WHALE WALLET** call, however small the buy.\n\n" +
    "/setwhale off to kill it.",
  setwhale_ok:
    "🐋 **Whale bar: {usd}**\n\n" +
    "A buy from a bag that size gets **pinned** in here.{unsupported}",
  // Appended to setwhale_ok as {unsupported}. Its own template because it is a
  // caveat an operator may want to word differently — or drop.
  setwhale_unsupported:
    "\n\n⚠️ Bags aren't readable on **{chain}** yet, so whale calls stay off until they are.",
  setwhale_off: "🐋 Whale calls **off** here.",
  pin_on: "📌 Whale calls get **pinned** — each new one replaces the last. Needs the **Pin messages** permission.",
  pin_off: "📌 Whale calls **won't be pinned** here.",
  buybot_on: "🟢 **Buy bot on** — calls resume.",
  buybot_off: "🔴 **Buy bot off** — calls paused. /buybot on brings it back.",
  // The empty state, and the shortest true instruction for getting out of it.
  // It used to say "Send /settoken <contract address>", which is the slowest of
  // the three ways that work and the only one requiring syntax. Pasting the
  // address on its own line is what the middleware in group/setup.js already
  // listens for, so that is what this leads with.
  buybot_need_token:
    "📄 **No token set here yet**\n\n" +
    "Paste your contract address in this chat — that's the whole setup. The network is detected from the address.\n\n" +
    "Or tap **📄 Add CA** below.",
  // ASKED, never assumed. A pasted address used to arm the buy bot on the spot,
  // which is how a group ended up watching a token nobody in it had chosen:
  // somebody pasted a CA to show it to someone, and the bot took it as an
  // instruction. Pointing a project's group at a contract is not a thing to
  // infer from a message that was never addressed to us.
  // {current} is the whole "this REPLACES …" line, so it vanishes on a group
  // with nothing set instead of leaving a dangling label.
  buybot_activate_ask:
    "🤖 **Activate the buy bot for this token?**\n\n" +
    "`{address}`\n" +
    "{current}" +
    "Requested by {requester}. Tap below to confirm or cancel.",
  buybot_activate_replaces: "⚠️ This **replaces** the token this group is watching now — **{symbol}**.\n\n",
  // Button labels for the card above, pipe separated: confirm | cancel.
  buybot_activate_buttons: "🤖 Activate buy bot|❌ Cancel",
  buybot_activate_cancelled: "Cancelled — nothing changed.",
  buybot_activate_stale: "That request expired. Paste the address again.",
  // The confirm behind 🗑 Remove CA. Says what STOPS and what is KEPT, because
  // an admin swapping one contract for another needs to know their floor and
  // whale bar are not about to be reset — and an admin who mis-tapped needs to
  // see instantly that this is the destructive one.
  buybot_remove_confirm:
    "🗑 **Remove {symbol}?**\n\n" +
    "`{address}`\n\n" +
    "Buy alerts stop the moment you confirm. Your minimum buy, whale bar and pin setting are **kept** — paste a new contract any time to start again.",
  // Button toast. Plain text: Telegram renders a callback answer as a bare
  // toast, so bold and links reach the tapper as literals.
  buybot_removed_toast: "Removed. Paste a new contract address to start again.",
  buybot_status:
    "📊 **Buy bot status**\n\n" +
    "🪙 **CA:** `{address}`\n" +
    "🔗 **Chain:** {chain}\n" +
    "💧 **Pool:** {pool}\n" +
    "💲 **Floor:** {minBuy}\n" +
    "🐋 **Whale bar:** {whale}\n" +
    "📌 **Pin whales:** {pin}\n" +
    "⚡ **State:** {state}",
  // /ca — "what's the contract?", the most-asked question in any token group.
  //
  // Deliberately NOT the status card. Somebody asking for the CA wants to paste
  // it into a wallet, not read the whale bar and the pin setting; a card that
  // answers a question by also answering six others is a card people stop
  // reading. The address is a `code` span so ONE TAP copies it — a hand-typed
  // contract address is a lost transaction.
  // 🔗 and not {chainEmoji} on the network row: {nameRow} already opens with the
  // network's own mark, and the same glyph twice in three lines reads as a
  // rendering fault. {chainEmoji} stays available if you lay the rows out
  // differently.
  // TIGHT. Name, network and address on three consecutive lines, one gap, then
  // the project's own links. Somebody asking for the CA is going to copy it and
  // leave; every blank line between them and the address is a line they scroll
  // past to get there.
  //
  // NO Chart / Trade / Dexvra row. Those three are on every buy alert this group
  // already receives, and repeating our own links under a question the project
  // asked about THEIR contract turns an answer into an advert.
  //
  // The 💵 and 🔗 are LITERALS here, not {chainEmoji}, so both show up in this
  // template's own "😀 Swap emoji" picker and can be changed without touching
  // the buy card. {chainEmoji} and {nameRow} are still available if you would
  // rather this row led with the network's mark like the buy card does.
  //
  // {links} is website / X / Telegram from DexScreener's pair info — the links a
  // newcomer asks for in the same breath as the CA. Rendered with dropEmpty, so
  // a token with no socials (most fresh launches) loses the whole row instead of
  // leaving a blank line where it was. Their icons and wording live in
  // `social_emojis` / `social_labels`.
  // {chainEmoji} is the NETWORK'S OWN mark, from the admin-editable
  // `chain_emojis` map — the same one the buy cards and the channel posts read,
  // so a premium Solana emoji set once lights up in all of them. It was already
  // passed to this template and simply never used: the row led with a fixed 🔗,
  // which told a reader "chain" next to a word that already said Solana, and
  // spent the only icon position on the row saying nothing.
  group_ca:
    "💵 {label}\n" +
    "{chainEmoji} {chain}\n" +
    "`{address}`\n\n" +
    "{links}",
  // The icons and the wording on the socials row — for /ca AND the /settoken
  // receipt, which build the same row.
  //
  // They used to be written into group/setup.js, so 🌐 𝕏 💬 were the only icons
  // on either card the "😀 Swap emoji" editor could not reach. Same gap 📃 and
  // 👤 had on the buy card, and the same fix: the glyph and the label are COPY
  // and live here; which of the three a token actually has is LOGIC and stays in
  // the code.
  //
  // A `key = emoji` map, so the picker labels each button with the network it
  // belongs to instead of showing three anonymous glyphs.
  social_emojis: "website = 🌐\nx = 𝕏\ntelegram = 💬",
  social_labels: "Website|X|Telegram",
  // ── Dexvra Raid ─────────────────────────────────────────────────────────
  // The live card and its three end states. {progress} is GENERATED (the goal
  // rows and their bars) because which rows exist depends on which goals are
  // set, and a flat template cannot express that — edit the copy around it, and
  // the characters INSIDE it via raid_style below.
  //
  // Premium emoji work in these four templates (they ARE the template, so they
  // travel in its entity array). They do NOT work inside {progress} or
  // raid_style — see the note on raid_style.
  raid_card:
    "🚀 **DEXVRA RAID {seq}**\n\n" +
    "📊 **{percent}% complete** · ⏱ **{left}** on the clock\n\n" +
    "{progress}\n\n" +
    "🤝 **Crew: {crew}**\n{roster}\n\n" +
    "📝 “{post}”\n\n" +
    "{note}\n" +
    "Updated {updated} UTC",
  raid_complete:
    "✅ **RAID {seq} — TARGETS HIT**\n\n" +
    "🎉 Every goal cleared. That's how it's done.\n\n" +
    "{progress}\n\n" +
    "🤝 **Crew: {crew}**\n{roster}\n\n" +
    "📝 “{post}”\n\n" +
    "Closed {updated} UTC",
  raid_expired:
    "⌛ **RAID {seq} — TIME'S UP**\n\n" +
    "📊 Finished at **{percent}%**. Good push — run it back.\n\n" +
    "{progress}\n\n" +
    "🤝 **Crew: {crew}**\n\n" +
    "Closed {updated} UTC",
  raid_cancelled:
    "🛑 **RAID {seq} — STOPPED**\n\n" +
    "📊 Stopped at **{percent}%** by an admin.\n\n" +
    "{progress}\n\n" +
    "Closed {updated} UTC",
  raid_complete_note: "✅ **Raid cleared.** Every target hit — {crew} of you turned up. 🚀",
  // ── The setup panel and its notices ─────────────────────────────────────
  // {goals} is GENERATED (one row per goal, with its live target) because which
  // rows exist depends on what is set — the same reason {progress} above is
  // generated. Everything around it is yours.
  //
  // {sources} is the one honest line about what THIS install can measure: with
  // no X key the Likes/Replies/Reposts goals cannot be read, and an operator
  // finding that out at launch instead of at setup is the failure it exists to
  // prevent. It empties itself when every source is available.
  raid_panel:
    "🚀 **DEXVRA RAID**\n\n" +
    "🔗 **Post:** {post}\n\n" +
    "🎯 **Targets**\n" +
    "{goals}\n\n" +
    "🔒 **Chat lock:** {lock}\n" +
    "{autoraid}\n" +
    "{record}\n\n" +
    "Targets count **up** from where the post is at launch. A raid runs {maxMinutes} min max.\n" +
    "{sources}",
  raid_panel_record: "📈 **Record:** {started} run · {completed} cleared",
  // LEADS WITH WHAT WORKS. These lines are read by a project's own members, in
  // their own group, and the first one used to open "No X key on this bot" —
  // which reads as a bot somebody forgot to finish setting up. It is the
  // opposite: needing no X account is the feature the welcome card sells
  // ("No X key needed — 🤝 Crew counts whoever shows up"), and a raid runs on
  // Crew alone by design.
  //
  // The constraint is still stated, because an admin who sets a Likes target
  // that can never move has been misled by a friendlier silence.
  raid_sources_none: "⚡ 🤝 **Crew** counts whoever shows up — no X account needed. **Likes** and **Replies** stay at 0 until an X key is set.",
  raid_sources_partial: "⚡ **Likes**, **Replies** and **Crew** are live. **Reposts** need a paid X key — leave that target off.",
  raid_group_only: "👥 Raids run in a group.\n\nAdd the bot to yours, make it admin, then hit /raid there.",
  raid_admin_only: "🔒 Group admins only.",
  // ── Auto-raid ──────────────────────────────────────────────────────────────
  // {autoraid} on the panel. A VALUE, so it carries NO markup: the saved-template
  // path inserts values verbatim beside `entities`, and a <b> would reach the
  // group as literal angle brackets. Emphasis is CAPS or an emoji.
  // The 🤖 block on the panel. LABELLED LINES — see src/raid/statusCopy.js for
  // why this is not raid_style's pipe form, and for the per-field fallback that
  // makes a one-line edit a one-line change. `-` on any line hides it.
  //
  // The icons live HERE rather than in code precisely so the emoji-swap screen
  // can see them: 🤖 and 👤 were literals in panel.js, which is why there was
  // nowhere to edit them and no way to make either premium.
  raid_status:
    "off_none: 🤖 Auto-raid: off — no X account set.\n" +
    "off_hint: 👤 X account names one, and then every new post starts a raid here by itself.\n" +
    "off_saved: 🤖 Auto-raid: off — @{handle} is saved but not being watched.\n" +
    "off_link: 🔗 An admin can still paste a post link here to raid it — that always works.\n" +
    "on: 🤖 Auto-raid: on — watching @{handle}\n" +
    "ok: ⏱ the bot is running, checked {when}\n" +
    "blind: 🚫 the bot hasn't been able to see X for {min}min — new posts will NOT be spotted\n" +
    "stalled: ⚠️ last check {when} — the bot may have stopped\n" +
    "ready: 👀 ready — only posts made from now on start a raid, older ones never will\n" +
    "notready: ⏳ not ready yet — it starts watching at the next check\n" +
    "starting: ⏳ starting up — it begins watching at the next check\n" +
    "pending: ⏸ 1 post is waiting — it starts when this raid finishes\n" +
    "outcome: ⚠️ last outcome ({when}): {reason}\n" +
    "link: 🔗 An admin pasting a post link here raids it immediately\n" +
    "link_only: 🔗 ADMIN: paste the post link here to raid it — this always works",
  raid_watch_prompt:
    "👤 Send the project's X account — @handle or a link to their profile.\n\n" +
    "Every NEW post on it starts a raid here with the goals above. Posts made BEFORE now never will.\n\n" +
    "Send - to stop watching. /cancel to leave it as it is.",
  raid_watch_set:
    "👤 Watching @{handle}.\n\n" +
    "Auto-raid is ON. Only posts made from now on start a raid — older ones never will.\n\n" +
    "You can also just paste their post link here and the raid starts immediately.",
  raid_watch_cleared: "👤 Not watching any account now. Auto-raid is off.",
  raid_watch_bad: "👤 That doesn't look like an X account. Send @handle, or a link to their profile.",
  // The two GROUP notices. They land in a customer's community chat, in front of
  // members who did not ask and cannot act — one line of what happened, one line
  // of what the ADMIN does, and nothing about our infrastructure or billing.
  raid_notice_failed:
    "⚡ A new post was spotted, but the raid couldn't start.\n\n{reason}\n\nAdmin: send this link here to raid it —\n{url}",
  raid_notice_blind:
    "⚡ The bot can't see this account's posts on X right now, so new ones won't start a raid on their own.\n\n" +
    "Admin: paste the post link here and the raid starts immediately.",
  raid_help:
    "❓ HOW A RAID WORKS\n\n" +
    "1. 🔗 Target post — send the X post you want raided.\n" +
    "2. Set the goals. 🤝 Crew counts whoever talks in this chat during the raid — it needs NO X account and always works.\n" +
    "3. 🚀 Launch raid. The bot posts a card and keeps it updated as the real numbers climb.\n\n" +
    "GOALS ARE HOW MANY MORE. A post already on 200 likes with a +15 goal finishes at 215, not at 15.\n\n" +
    "👤 X ACCOUNT is optional. Name the project's account and every new post starts a raid by itself. " +
    "You can also paste a post link here at any time and the raid starts immediately — that always works, " +
    "even when X won't show the bot that account's posts.\n\n" +
    "🔒 CHAT LOCK is off by default. When it is on the chat is muted until the goals are met, and it is ALWAYS " +
    "re-opened — when the raid completes, when it expires, when an admin stops it, and even if the bot restarts.",
  // The example is deliberately NOT a Dexvra link. It used to be, and it told
  // the reader to paste a post from an account that is not theirs — the raid is
  // meant to point at the PROJECT's own post.
  raid_seturl_prompt: "🔗 **Paste the X post link you want raided.**\n\nLike: `https://x.com/yourproject/status/1234567890`",
  raid_bad_url: "❌ That isn't an X post link.\n\nPaste the full URL of the post — it has to contain `/status/`.",
  raid_none_running: "🚀 Nothing running here.\n\nHit /raid to set one up.",
  // Launch refusals. Only the ones that are pure prose live here — the two that
  // splice in a diagnostic from the X layer ("…— 429 from the guest API") stay
  // in runner.js, because an operator cannot improve a machine-generated reason
  // and a botched edit would hide the one line that says what actually broke.
  raid_already_running: "🚀 One is already running here.",
  raid_already_launching: "⏳ That raid is already being launched.",
  raid_bad_post: "❌ That post link doesn't look right.\n\nPaste the full URL of an X post.",
  raid_no_goals: "🎯 Set at least one target first.",
  raid_reposts_only:
    "🔁 Reposts are the only target set, and nothing can count them without a **paid** X key.\n\n" +
    "Add ❤️ **Likes**, 💬 **Replies** or 🤝 **Crew** and launch again.",
  // The icons and bar characters inside {progress}. Six fields, pipe-separated:
  //   likes | replies | reposts | crew | bar-filled | bar-empty
  // PLAIN UNICODE ONLY. This string is split apart and rebuilt inside a
  // generated block, so it cannot carry the template's premium-emoji entities —
  // a premium emoji here reaches the group as a plain fallback character at
  // best. Try coloured blocks for a bolder bar: ❤️|💬|🔁|🤝|🟩|⬛
  // A missing or malformed field falls back to its own default, so a typo
  // cannot break the card. Must stay in step with STYLE_DEFAULT in raid/card.js.
  raid_style: "❤️|💬|🔁|🤝|▰|▱",
  massdm_disabled: "📣 Mass DM broadcasts are paused right now — check back soon.",
  massdm_intro:
    `${em("📢", E.megaphone)} **Mass DM Broadcast**\n\n` +
    "Send your message as a **direct DM to every Dexvra user** — the strongest reach we offer. Every broadcast is admin-reviewed before it sends (keeps the audience clean and the bot safe).\n\n" +
    // ⚠️ NO DISCOUNT CLAIM HERE. The three prices below are placeholders fed
    // from MASS_DM_PRICE and therefore live; a "— 50% off" typed beside them
    // is frozen, so the day the discount was withdrawn this card went on
    // advertising one over the full price — the label contradicting its own
    // figures, which is the buy card's two-ideas-of-"whale" defect on a price.
    // A real discount must ride a placeholder, never the copy.
    "**Flat price** (charged in your token's chain)\n" +
    "◎ {sol}  ·  🟡 {bnb}  ·  ⧫ {eth}\n\n" +
    `${em("🔗", E.link)} **First, paste your token's contract address (CA).**\n` +
    "It sets the chain you'll pay in:",
  massdm_ca_invalid:
    `${em("❌", E.cross)} That doesn't look like a contract address.\n\n` +
    "Paste a valid token CA — an 0x… address (Ethereum / BSC / Base), a Solana mint, a Tron or TON address:",
  massdm_compose_prompt:
    "✅ Token detected on **{chain}** — you'll pay **{amount}**.\n\n" +
    "Now send your broadcast — **text, or a photo/GIF with a caption** (formatting & emoji are kept).\n" +
    "📎 A photo is **optional**: send the text now and you can attach one — or leave it text-only — on the next screen.",
  // ⚠️ ITS OWN KEY, because the card above makes a CLAIM. Chain detection is
  // bounded (CA_RESOLVE_MS) and can come back with nothing — the queue was
  // long, or the token has no live pool anywhere — and the flow then bills the
  // buyer in whatever currency the ADDRESS SHAPE suggests, which for any 0x… is
  // simply the first candidate. Rendering that through "✅ Token detected on X"
  // is a failure of ours dressed as a fact about their token, on the screen
  // that decides what they pay. Same two placeholders, so an operator who has
  // saved the card above is unaffected by this one existing.
  massdm_chain_unconfirmed:
    "⚠️ **We couldn't confirm this token's chain just now.**\n\n" +
    "Going by the address, it looks like **{chain}** — so you'd pay **{amount}**. " +
    "If that's the wrong network, tap 🏠 Home and start again.\n\n" +
    "Otherwise send your broadcast — **text, or a photo/GIF with a caption** (formatting & emoji are kept).\n" +
    "📎 A photo is **optional** — you can attach one, or leave it text-only, on the next screen.",
  // ⚠️ THE ATTACHMENT ROW IS APPENDED, NEVER A PLACEHOLDER, and that is what
  // makes it editable with PREMIUM EMOJI. A placeholder is substituted into
  // this card as MARKUP, and an operator who PASTES a row carrying custom emoji
  // has it stored as {text, entities} — whose entities a markup substitution
  // cannot carry, so the 💎 would be silently flattened on exactly the surface
  // this repo just promised would keep it. Rendered whole and appended
  // (ensureMediaLine), the row is an ordinary template render and its entities
  // survive. A {media} typed in here renders EMPTY and the row is still
  // appended, so the card degrades rather than losing the state it reports.
  massdm_preview:
    "👆 **This is your broadcast.**\n\n" +
    "It goes to every Dexvra user as a DM once an admin approves — **{amount}**. Pay below, or edit it:",
  massdm_media_none: "📎 **No photo attached** — it will go out as text only. That is fine; tap 📎 Add a photo below if you want one.",
  massdm_media_on: "📎 **{kind} attached** — it goes out with your message. Tap 🖼 Change or 🗑 Remove below.",
  // ⚠️ The preview above the card is best-effort, and a preview that did not
  // render leaves "👆 This is your broadcast" pointing at nothing — a claim over
  // a broken thing. Said, rather than swallowed.
  massdm_media_unpreviewable:
    "📎 **{kind} attached**, but Telegram wouldn't show it back to you just now. " +
    "It is still on your broadcast — tap 🗑 Remove below if you would rather send text only.",
  massdm_media_prompt:
    "📎 **Send the photo or GIF now.**\n\n" +
    "Send it as a **photo/GIF, not as a file**. A caption is optional — send one and it replaces your text; send none and your text is kept as the caption.\n\n" +
    "Don't want one? Use the button below — text-only broadcasts are perfectly fine.",
  // ⚠️ NAMES BOTH READINGS RATHER THAN GUESSING. Text arriving at the photo step
  // is either a new caption or a buyer who forgot to attach, and silently taking
  // one reading overwrites what they wrote.
  massdm_media_not_photo:
    "That came through as text, not a photo.\n\n" +
    "Send the **photo or GIF** itself (a caption on it replaces your text), or tap the button below to keep your broadcast text-only.",
  massdm_media_as_file:
    "That arrived as a **file**, and Telegram will not let us broadcast it as a photo.\n\n" +
    "Send the same image from your gallery as a **photo** (not \"send as file\"), or keep the broadcast text-only.",
  // ⚠️ REFUSED, NEVER TRIMMED. Telegram caps a media caption at {limit} UTF-16
  // units and THROWS past it, so attaching a photo to a longer text would fail
  // every single send of a broadcast somebody paid for — and trimming it instead
  // would silently delete most of what they wrote. Nothing is changed.
  massdm_media_too_long:
    "⚠️ **That photo can't go on this message.**\n\n" +
    "Your text is **{len}** characters and a photo caption holds at most **{limit}**. " +
    "Nothing was changed — tap ✏️ Edit to shorten it, or send the broadcast text-only.",
  massdm_media_set: "📎 **{kind} attached.** {caption}",
  massdm_media_cleared: "🗑 **Photo removed** — your broadcast goes out as text only.",
  // ⚠️ ✏️ Edit KEEPS THE TOKEN, which is the whole difference from the button it
  // replaced: ✏️ Recompose restarted the flow at "paste your CA", throwing away
  // the chain detection that had just been paid for in latency — a label
  // promising one thing over an action doing another. It also keeps any photo,
  // so the prompt says so: a new message silently dropping the attachment is
  // the same destruction the caption rule refuses one step over.
  massdm_edit_prompt:
    "✏️ **Send the new message** — text, or a photo/GIF with a caption.\n\n" +
    "It replaces what you wrote. Any photo already attached **stays** unless you send a new one — use 🗑 Remove photo on the next screen to drop it.",
  massdm_received:
    "✅ **Payment received — your broadcast is in review.**\n\n" +
    "Ref `{ref}`. An admin will approve it shortly; delivery starts right after. You'll get a receipt here when it's done.",
  massdm_enqueue_failed:
    "⚠️ **We're on it.**\n\n" +
    "Your payment arrived (ref `{ref}`) but queuing the broadcast hit a snag. Your funds are safe — contact support with this ref and we'll push it through.",
  // ── Broadcast add-on on a listing order ──────────────────────────────────
  // ⚠️ NO COMPOSE PROMPT ANY MORE, and no "attached" toast: the add-on is one
  // tap and the card itself shows the state. The prompt/attached copy is gone
  // rather than reworded — a template an operator can still edit for a step
  // that no longer exists is the row the engine ignores.
  broadcast_addon_sending:
    "📣 **Your broadcast is going out now.**\n\n" +
    "Ref `{ref}`. Every Dexvra bot user is being DM'd your listing card — the same one that just went to the channel. You'll get a receipt here when it's done.",
  // Kept for an order armed BEFORE the add-on became one tap: it carries the
  // buyer's own composed message and still goes through review, which is what
  // they bought. recovery.js re-checks pending orders for a day.
  broadcast_addon_queued:
    "📣 **Your broadcast is in review.**\n\n" +
    "Ref `{ref}`. An admin will approve it shortly; delivery starts right after.",
  broadcast_addon_failed:
    "⚠️ **Your listing is live — the broadcast needs a hand.**\n\n" +
    "Queuing it hit a snag (ref `{ref}`). Nothing else about your order changed. Contact support with this ref and we'll push it through.",
  massdm_test_queued:
    "🧪 **Test broadcast queued (FREE).**\n\n" +
    "It'll be delivered to the admins and you within a few seconds, with a delivery report — no review, no charge.",
  // ⚠️ NO RAW REACHED COUNT. "jgn sebut number, blg aja to all user dexvra dan
  // berapa banyak yang gagal" — the buyer is told it went out and what could
  // not be reached, the shape the reference bot uses. Both lines come from ONE
  // owner shared with the ops report (massdm/sender.js reachLine/failLine), so
  // the two surfaces can never disagree about whether it reached everybody.
  // {reached} still resolves, for an operator whose saved copy carries it.
  massdm_done:
    "✅ **Your Dexvra broadcast is delivered.**\n\n" +
    "**Ref:** `{ref}`\n{reach}{fail}\n\nThanks for using Dexvra.",
  upsell_expiry:
    "⏰ **Your Trending slot is ending**\n\n" +
    "🔹 **{symbol}**'s featured placement on the Dexvra Trending board ends in about **{hours}h**.\n\n" +
    "🔥 Extend now to keep your spot without a gap — a **{discount}% renewal discount** is already applied below:",

  // ── Channel post layouts — ONE self-contained template per post type ──
  // What you see in the editor IS the whole post: header, data rows, social
  // links and footer all live in the same template (no separate fragments).
  // Only live values are {placeholders}. channels/format.js drops a social
  // line whose link the token doesn't have — and the whole social paragraph
  // (incl. its header line) when the token has none — before rendering; the
  // tier badge line drops the same way on a listing without a tier.
  // {logoEmoji} sits at the RIGHT end of the header (operator preference) — and
  // OUTSIDE the bold run: a custom-emoji tag inside **…** would be skipped by
  // the markup parser and leak as raw text.
  post_listing_xpress:
    `${em("⚡", E.zap)} **Xpress Listing — {name} live on Dexvra** {logoEmoji}\n\n` + LISTING_BODY,
  // Tier sits BESIDE the header, not stacked under it, and the token's own
  // emoji closes the line (operator preference): "New Listing on Dexvra ·
  // 💠 Platinum tier 🐶". An untiered listing drops just the tier SEGMENT —
  // channels/format.js keeps the header itself.
  post_listing_tiered:
    // {tierEmoji} is whatever the operator set for that tier in the
    // `tier_emojis` template below — a premium emoji if they sent one. It was
    // briefly removed when the badge was a hardcoded trophy nobody chose; the
    // objection was to the emoji, not to the badge.
    `${em("🚨", E.sirenHead)} **New Listing on Dexvra** · {tierEmoji} **{tier} tier** {logoEmoji}\n\n` +
    LISTING_BODY,
  post_trending: `🔥 **New Trending on Dexvra** {logoEmoji}\n\n` + LISTING_BODY,
  // The caption under a Top-Gainers banner. {list} is the ranked leaderboard,
  // built by gainers.js — one line per token, each carrying its rank badge (the
  // same badges the trending board uses, so a premium one animates here too),
  // a link to the token's Dexvra page, its X handle when it has one, and the 24h
  // move. It arrives as ONE placeholder because the number of lines depends on
  // how many live gainers exist; everything around it is yours to reword.
  post_gainers:
    `${em("📈", E.chartUp)} **TOP GAINERS ON DEXVRA**\n` +
    `🗓 {date}\n\n` +
    `{list}\n\n` +
    `${em("📊", E.chart)} Ranked by **24h change** across every token listed on Dexvra.\n\n` +
    // The board's own tweet. Unlike the coin cards this template is rendered
    // with dropEmpty (it has no stripForCoin path), so the line disappears with
    // its blank separator when the board wasn't tweeted.
    `[Announce On X 𝕏]({xUrl})\n\n` +
    LINKS_ROW,
  // Advertiser-facing, so it reads like an ad placement announcement rather than
  // bot output: what is running, where, and one link out. The "Announce On X"
  // line carries the campaign's tweet and drops itself when there is none.
  post_banner:
    `${em("⚡", E.zap)} **BANNER LIVE ON DEXVRA** ${em("⚡", E.zap)}\n\n` +
    // The title is the click-through. NOT bold-inside-link: the markup parser
    // doesn't nest, and `[**x**](url)` leaks its asterisks into the post.
    `▶️ [{title}]({linkUrl})  ·  {slot}\n\n` +
    // The advertiser's OWN copy. Each block below is its own paragraph so it
    // disappears cleanly (header line included) when they didn't supply it —
    // plenty of campaigns are a service or an event with no token behind them.
    `{description}\n\n` +
    `${em("📄", E.clip)} **CA**\n` +
    "`{address}`\n\n" +
    `${em("🔗", E.link)} **Socials**\n` +
    `${em("❌", E.cross)} [X]({twitter}) · 🌐 [Website]({website}) · ✈️ [Telegram]({telegram})\n\n` +
    `[Announce On X 𝕏]({xUrl})\n\n` +
    FOOTER_BLOCK,
  // Rank-up is a TICKER post, not an article: the clip carries the hype and the
  // caption just says which token moved, where to read it, and the CA — then the
  // full Dexvra link row. Kept deliberately short (Moontok-style) — the long
  // version buried the ticker under three paragraphs of copy. {change} (a
  // sentence) and {gain} (compact "+42%") stay available for admins who want the
  // number back.
  post_rankup:
    `{chainEmoji} **{symbol}** ${em("📈", E.chartUp)} Rank ↑ **#{rank}** on Dexvra Trending\n` +
    `[{coinUrlLabel}]({coinUrl})\n\n` +
    `${em("📄", E.clip)} **CA**\n` +
    "`{address}`\n\n" +
    // Links the rank-up's OWN tweet; the line drops itself when there is none
    // (X off, or the post failed) — see stripForCoin/autoSocialCuts.
    `[Announce On X 𝕏]({xUrl})\n\n` +
    LINKS_ROW,
  // Same ticker shape as post_rankup: the clip carries the hype, the caption
  // states the fact. The old version buried "+2,400%" under four paragraphs of
  // copy and a per-token social row — by the time a reader got to the number it
  // had stopped being news. What was cut was the PROSE, not the destinations:
  // the Dexvra link row stays complete. {percent}, {name} and {chain} stay
  // available.
  post_pump:
    `{chainEmoji} **{symbol}** ${em("🚀", E.rocket)} **{multiple}** since listing\n` +
    `[{coinUrlLabel}]({coinUrl})\n\n` +
    // Labelled, so the two numbers read as a market-cap move and not as a
    // price, a range, or a target.
    `${em("📊", E.chart)} **Market cap:** {firstMc} → {lastMc}\n\n` +
    `${em("📄", E.clip)} **CA**\n` +
    "`{address}`\n\n" +
    // The pump alert's own tweet (a QUOTE of the token's listing tweet), so the
    // channel post and the X post point at each other. Drops when there is none.
    `[Announce On X 𝕏]({xUrl})\n\n` +
    LINKS_ROW,
  // Per-TIER badge shown beside the header on a listing post ("New Listing on
  // Dexvra · 💎 Diamond tier"). Same shape as chain_emojis: one `tier = emoji`
  // per line. Send a PREMIUM emoji here and the badge animates in the channel —
  // that is the whole point of it being a template rather than code.
  // A tier missing from this list falls back to the emoji in config/packages.js.
  tier_emojis:
    "diamond = 💎\n" +
    "gold = 🥇\n" +
    "platinum = 🏆\n" +
    "silver = 🥈\n" +
    "bronze = 🥉\n" +
    "xpress = ⚡",
  // Per-network emoji the bot AUTO-PICKS from the token's chain. One
  // `chainid = emoji` per line; unknown chains fall back to 💠. Edit an emoji to
  // rebrand a network everywhere at once.
  //
  // TWO PLACES READ THIS, not one: the "Chain:" line on a channel post, and the
  // token row on every group buy alert ({chainEmoji} in group_name_row). That is
  // deliberate — the network mark a reader learns in the channel is the same one
  // that leads the buy card.
  //
  // PREMIUM EMOJI WORK HERE. Paste the real network logos as custom emoji and
  // channels.js rebuilds them as premium markup, so every Solana buy card in
  // every group carries the animated Solana mark from one edit.
  chain_emojis:
    "solana = 🟣\n" +
    "ethereum = 🔷\n" +
    "bsc = 🟡\n" +
    "base = 🔵\n" +
    "robinhood = 🪶\n" +
    "tron = 🔴\n" +
    "ton = 🔹\n" +
    "sui = 💧\n" +
    "plasma = 🟢",

  // ── X / Twitter posts (PLAIN TEXT — X has no markdown; keep under ~280
  //    chars: a URL counts as 23, each emoji ~2). Footer order Listing →
  //    Trending → Announcement. Posted on a successful listing/trending order. ──
  x_listing:
    "⚡ New Listing on Dexvra\n\n" +
    "{name} ( ${tag} ){mention}\n" +
    "{url}\n\n" +
    "CA: {address}\n\n" +
    "Price: {price}  |  MC: {mcap}\n\n" +
    "#Dexvra #NewListing #Altcoin #DYOR",
  x_listing_tiered:
    "⚡ New Listing on Dexvra\n\n" +
    "{tierEmoji} {tier} Tier — Trending Now\n\n" +
    "{name} ( ${tag} ){mention}\n" +
    "{url}\n\n" +
    "CA: {address}\n\n" +
    "Price: {price}  |  MC: {mcap}\n\n" +
    "#Dexvra #NewListing #Altcoin #DYOR",
  x_trending:
    "🔥 {symbol} is now Trending on Dexvra!\n\n" +
    "💎 {name}  ·  {chain}\n" +
    "🔗 {url}\n\n" +
    "🌐 dexvra.io | 🚨 Listing | 🔥 Trending | 📢 Announcement\n" +
    "#Dexvra #Trending #{tag} #DYOR",
  // Posted as a QUOTE of the token's original listing tweet (the listing card
  // shows below), so this text stays short and focused on the pump news.
  x_pump:
    "🚀 Pump Alert — ${tag} on Dexvra\n\n" +
    "{name}{mention} is up +{percent}% since it listed on Dexvra.\n\n" +
    "MC: {firstMc} → {lastMc}\n" +
    "{url}\n\n" +
    "#Dexvra #Pump #Altcoin #DYOR",
  // Also a QUOTE of the listing tweet — the token's own card underneath is what
  // makes "climbed to #2" mean anything. {gain} is "+42%" or empty when the
  // reading was absurd/negative, so keep it on its own segment.
  x_rankup:
    "📈 Rank Up — ${tag} is #{rank} on Dexvra Trending\n\n" +
    "{name}{mention} {gain} (24h)\n" +
    "{url}\n\n" +
    "#Dexvra #Trending #{tag} #DYOR",
  // Banner ads. Was hardcoded in twitter.js and ignored the editor entirely —
  // an advertiser's announcement is exactly the copy an operator wants to tune.
  x_banner:
    "📢 Banner Live on Dexvra\n\n" +
    "{title}{mention} is now featured on {handle}\n" +
    "{url}\n\n" +
    "#Dexvra #Ad",
  // The daily Top Gainers board. {list} is built by gainers.js as PLAIN text
  // (X has no markdown and no custom emoji) — one ranked line per token.
  x_gainers:
    "📈 TOP GAINERS ON DEXVRA\n" +
    "{date}\n\n" +
    "{list}\n\n" +
    "Ranked by 24h change across every token listed on Dexvra.\n" +
    "{site}\n\n" +
    "#Dexvra #TopGainers #Altcoin #DYOR",
};

// ── Editor metadata: groups + placeholder hints ──────────────────────────────
const META = {
  welcome: { group: "Bot Messages", label: "Welcome / Start", ph: ["site", "announce", "listing", "trending", "xlisting"] },
  intro_xpress: { group: "Bot Messages", label: "Intro: Xpress Listing", ph: ["site", "listing", "trending", "announce", "xlisting"] },
  intro_tiered: { group: "Bot Messages", label: "Intro: Listing & Trending", ph: ["site", "listing", "trending", "announce", "xlisting"] },
  tier_chooser: { group: "Bot Messages", label: "Tier chooser", ph: ["native", "site", "listing", "trending", "announce", "xlisting"] },
  trending_durations: { group: "Bot Messages", label: "Trending: duration picker", ph: ["symbol", "chain", "native", "site", "listing", "trending", "announce", "xlisting"] },
  intro_banner: { group: "Bot Messages", label: "Intro: Banner Ads", ph: ["site", "listing", "trending", "announce", "xlisting"] },
  listing_ca_prompt: { group: "Bot Messages", label: "Prompt: contract address", ph: ["chain"] },
  listing_name_prompt: { group: "Bot Messages", label: "Prompt: token name", ph: [] },
  listing_symbol_prompt: { group: "Bot Messages", label: "Prompt: token symbol", ph: [] },
  listing_logo_prompt: { group: "Bot Messages", label: "Prompt: logo", ph: [] },
  trending_ca_prompt: { group: "Bot Messages", label: "Prompt: trending CA", ph: ["site", "listing", "trending", "announce", "xlisting"] },
  already_listed: { group: "Bot Messages", label: "Listing: token already listed", ph: ["name", "symbol", "chain", "address", "url", "site", "listing", "trending", "announce", "xlisting"] },
  trending_not_found: { group: "Bot Messages", label: "Trending: token not listed", ph: [] },
  // {bonding} carries its OWN leading blank line and is empty for a migrated
  // token, so the card has no gap where the line would be. An admin who has
  // already saved this template simply will not have the placeholder and will
  // not see the notice — ♻️ Reset default picks it up.
  review_card: { group: "Bot Messages", label: "Listing review card", ph: ["chain", "name", "symbol", "address", "logo", "overview", "website", "twitter", "telegram", "bonding"] },
  edit_field_prompt: { group: "Bot Messages", label: "Edit-field prompt", ph: ["field"] },
  invalid_address: { group: "Bot Messages", label: "Error: invalid address", ph: ["chain"] },
  invalid_url: { group: "Bot Messages", label: "Error: invalid URL", ph: [] },
  invalid_ticker: { group: "Bot Messages", label: "Error: invalid ticker", ph: [] },
  listing_incomplete: { group: "Bot Messages", label: "Error: listing incomplete", ph: [] },
  pricing_unavailable: { group: "Bot Messages", label: "Error: pricing unavailable", ph: [] },
  session_expired: { group: "Bot Messages", label: "Error: session expired", ph: [] },
  error_retry: { group: "Bot Messages", label: "Error: try again", ph: [] },
  trending_service_down: { group: "Bot Messages", label: "Error: listings service down", ph: [] },
  banner_duration_prompt: { group: "Bot Messages", label: "Banner: duration picker", ph: ["name", "size"] },
  banner_image_prompt: { group: "Bot Messages", label: "Banner: image prompt", ph: ["size", "size2x"] },
  banner_link_prompt: { group: "Bot Messages", label: "Banner: link prompt", ph: [] },
  banner_title_prompt: { group: "Bot Messages", label: "Banner: title prompt", ph: [] },
  banner_desc_prompt: { group: "Bot Messages", label: "Banner: description prompt", ph: [] },
  banner_ca_prompt: { group: "Bot Messages", label: "Banner: contract prompt", ph: [] },
  banner_socials_prompt: { group: "Bot Messages", label: "Banner: socials prompt", ph: [] },
  banner_pay_prompt: { group: "Bot Messages", label: "Banner: pay-method picker", ph: ["slot", "size", "duration", "usd"] },
  price_feed_down: { group: "Bot Messages", label: "Error: price feed down", ph: [] },
  checking_payment: { group: "Bot Messages", label: "Payment: checking", ph: ["chain", "amount", "native"] },
  still_checking: { group: "Bot Messages", label: "Payment: still checking", ph: [] },
  no_pending_payment: { group: "Bot Messages", label: "Payment: none pending", ph: [] },
  pay_card: { group: "Bot Messages", label: "Payment card", ph: ["label", "amount", "native", "address", "network"] },
  pay_pick: { group: "Bot Messages", label: "Payment: choose network", ph: ["label"] },
  pay_card_admin: { group: "Bot Messages", label: "Payment card (admin free)", ph: ["label"] },
  pay_card_broadcast: { group: "Bot Messages", label: "Payment card: broadcast add-on line", ph: ["fee"] },
  pay_card_broadcast_admin: {
    group: "Bot Messages",
    label: "Payment card: broadcast add-on line (admin free)",
    ph: [],
  },
  payment_not_detected: { group: "Bot Messages", label: "Payment not detected", ph: ["amount", "native", "address", "order"] },
  payment_snag: { group: "Bot Messages", label: "Payment snag", ph: ["order"] },
  payment_already_credited: { group: "Bot Messages", label: "Payment already credited", ph: ["order"] },
  success_listing: { group: "Bot Messages", label: "Success: Xpress listing", ph: ["symbol", "name", "siteUrl", "listingUrl", "xUrl", "postLinks", "announceX", "site", "listing", "trending", "announce", "xlisting"] },
  success_listing_tiered: { group: "Bot Messages", label: "Success: Listing & Trending", ph: ["symbol", "name", "tier", "tierEmoji", "hours", "siteUrl", "listingUrl", "xUrl", "announceUrl", "trendingUrl", "postLinks", "announceX", "site", "listing", "trending", "announce", "xlisting"] },
  success_trending: { group: "Bot Messages", label: "Success: trending", ph: ["symbol", "hours", "siteUrl", "trendingUrl", "announceUrl", "xUrl", "postLinks", "announceX", "site", "listing", "trending", "announce", "xlisting"] },
  success_banner: { group: "Bot Messages", label: "Success: banner", ph: ["slot", "startsAt", "endsAt", "queueNote", "postLinks", "announceX", "site", "listing", "trending", "announce", "xlisting"] },
  upsell_expiry: { group: "Bot Messages", label: "Upsell: trending slot ending", ph: ["symbol", "hours", "discount"] },
  group_added: { group: "Group Setup", label: "Group: posted the moment the bot is added", ph: ["bot", "site", "listing", "trending", "announce", "xlisting"] },
  group_start: { group: "Group Setup", label: "Group: /start inside a group", ph: ["bot", "site", "listing", "trending", "announce", "xlisting"] },
  buybot_help: { group: "Group Buy Bot", label: "Group tools: how-to (main menu)", ph: ["bot", "site", "listing", "trending", "announce", "xlisting"] },
  group_buy_alert: { group: "Group Buy Bot", label: "Group: buy alert (verified txn)", ph: ["intro", "poweredBy", "listingChannel", "bar", "emoji", "name", "nameRow", "tier", "symbol", "usd", "native", "tokenAmt", "price", "mcap", "liq", "impact", "change", "chain", "chainEmoji", "verify", "wallet", "holds", "holdsUsd", "position", "tradeUrl", "coinUrl", "chartUrl"] },
  group_start_buttons: { group: "Group Buy Bot", label: "Group welcome buttons (buybot|raid|settings|listing|channel)", ph: [] },
  buybot_remove_confirm: { group: "Group Buy Bot", label: "Group: confirm removing the CA", ph: ["symbol", "address"] },
  buybot_removed_toast: { group: "Group Buy Bot", label: "Group: CA removed (toast)", ph: [] },
  group_buy_intro: { group: "Group Buy Bot", label: "Group: banner line above a buy", ph: [] },
  group_whale_intro: { group: "Group Buy Bot", label: "Group: banner line above a whale", ph: [] },
  group_powered_by: { group: "Group Buy Bot", label: "Group: byline on the header line", ph: ["listingChannel"] },
  group_name_row: { group: "Group Buy Bot", label: "Group: the token row", ph: ["chainEmoji", "label", "name", "symbol"] },
  group_buyer_row: { group: "Group Buy Bot", label: "Group: the buyer + txn row", ph: ["buyer", "txn"] },
  group_position_row: { group: "Group Buy Bot", label: "Group: the Position row", ph: ["holds", "symbol", "holdsUsd", "position", "wallet", "walletUrl"] },
  group_buy_style: { group: "Group Buy Bot", label: "Buy size icons (buy|whale)", ph: [] },
  group_whale_alert: { group: "Group Buy Bot", label: "Group: WHALE WALLET alert (pinned)", ph: ["introWhale", "poweredBy", "listingChannel", "bar", "emoji", "name", "nameRow", "symbol", "usd", "wallet", "native", "tokenAmt", "holds", "holdsUsd", "position", "whaleBar", "price", "mcap", "liq", "change", "chain", "chainEmoji", "verify", "tradeUrl", "coinUrl", "chartUrl"] },
  group_buy_tiers: { group: "Group Buy Bot", label: "Buy tiers (normal|whale|mega)", ph: [] },
  // Own category: 22 setup replies stacked into "Group Buy Bot" would bury the
  // alert cards, which are what an operator actually opens this editor for.
  setup_admin_only: { group: "Group Setup", label: "Error: group admins only", ph: [] },
  setup_group_only: { group: "Group Setup", label: "Error: run it in a group", ph: [] },
  settoken_prompt: { group: "Group Setup", label: "/settoken — paste prompt", ph: [] },
  settoken_resolving: { group: "Group Setup", label: "/settoken — looking it up", ph: [] },
  settoken_not_found: { group: "Group Setup", label: "/settoken — no pool found", ph: [] },
  settoken_resolve_slow: { group: "Group Setup", label: "/settoken — lookup timed out", ph: [] },
  settoken_ok: {
    group: "Group Setup",
    label: "/settoken — live ✅",
    ph: ["chain", "chainEmoji", "name", "nameRow", "symbol", "address", "links", "website", "twitter", "telegram", "minBuy", "whale"],
  },
  setchain_unknown: { group: "Group Setup", label: "/setchain — unknown network", ph: ["chains"] },
  setchain_need_token: { group: "Group Setup", label: "/setchain — set the token first", ph: [] },
  setchain_ok: { group: "Group Setup", label: "/setchain — done", ph: ["chain"] },
  setchain_ok_nopool: { group: "Group Setup", label: "/setchain — done, no pool yet", ph: ["chain"] },
  setminbuy_panel: { group: "Group Setup", label: "/setminbuy — picker", ph: ["usd"] },
  setminbuy_usage: { group: "Group Setup", label: "/setminbuy — not an amount", ph: [] },
  setminbuy_ok: { group: "Group Setup", label: "/setminbuy — done", ph: ["usd"] },
  setminbuy_min: { group: "Group Setup", label: "/setminbuy — below the floor", ph: ["usd"] },
  setminbuy_toast: { group: "Group Setup", label: "/setminbuy — button toast", ph: ["usd"] },
  setwhale_panel: { group: "Group Setup", label: "/setwhale — picker", ph: ["usd", "chain", "unsupported"] },
  setwhale_toast: { group: "Group Setup", label: "/setwhale — button toast", ph: ["usd"] },
  setwhale_state_off: { group: "Group Setup", label: "Whale bar — the word for off", ph: [] },
  setwhale_usage: { group: "Group Setup", label: "/setwhale — not an amount", ph: [] },
  setwhale_ok: { group: "Group Setup", label: "/setwhale — done", ph: ["usd", "chain", "unsupported"] },
  setwhale_unsupported: { group: "Group Setup", label: "/setwhale — chain can't be read", ph: ["chain"] },
  setwhale_off: { group: "Group Setup", label: "/setwhale off", ph: [] },
  pin_on: { group: "Group Setup", label: "/buybot pin on", ph: [] },
  pin_off: { group: "Group Setup", label: "/buybot pin off", ph: [] },
  buybot_on: { group: "Group Setup", label: "/buybot on", ph: [] },
  buybot_off: { group: "Group Setup", label: "/buybot off", ph: [] },
  buybot_need_token: { group: "Group Setup", label: "/buybot — not set up yet", ph: [] },
  buybot_status: { group: "Group Setup", label: "/buybot — status card", ph: ["address", "chain", "pool", "minBuy", "whale", "pin", "state"] },
  buybot_activate_ask: { group: "Group Setup", label: "Pasted CA: activate buy bot?", ph: ["address", "requester", "current"] },
  buybot_activate_replaces: { group: "Group Setup", label: "Pasted CA: the 'this replaces' warning", ph: ["symbol"] },
  buybot_activate_buttons: { group: "Group Setup", label: "Pasted CA: buttons (activate|cancel)", ph: [] },
  buybot_activate_cancelled: { group: "Group Setup", label: "Pasted CA: cancelled toast", ph: [] },
  buybot_activate_stale: { group: "Group Setup", label: "Pasted CA: expired request toast", ph: [] },
  group_ca: { group: "Group Setup", label: "/ca — the contract address", ph: ["label", "nameRow", "name", "symbol", "chain", "chainEmoji", "address", "links", "website", "twitter", "telegram", "chartUrl", "tradeUrl", "coinUrl"] },
  social_emojis: { group: "Group Setup", label: "Socials row: icons (website/X/telegram)", ph: [] },
  social_labels: { group: "Group Setup", label: "Socials row: wording (website|x|telegram)", ph: [] },
  raid_card: { group: "Dexvra Raid", label: "Raid: live card", ph: ["seq", "percent", "left", "crew", "roster", "progress", "url", "post", "updated", "note"] },
  raid_complete: { group: "Dexvra Raid", label: "Raid: all targets hit", ph: ["seq", "percent", "crew", "roster", "progress", "url", "post", "updated"] },
  raid_expired: { group: "Dexvra Raid", label: "Raid: time ran out", ph: ["seq", "percent", "crew", "progress", "url", "post", "updated"] },
  raid_cancelled: { group: "Dexvra Raid", label: "Raid: stopped by an admin", ph: ["seq", "percent", "progress", "url", "post", "updated"] },
  raid_complete_note: { group: "Dexvra Raid", label: "Raid: shout when it clears", ph: ["crew", "url"] },
  raid_style: { group: "Dexvra Raid", label: "Raid bar style (likes|replies|reposts|crew|filled|empty)", ph: [] },
  raid_panel: { group: "Dexvra Raid", label: "Raid: setup panel (/raid)", ph: ["post", "goals", "lock", "autoraid", "record", "maxMinutes", "sources"] },
  raid_panel_record: { group: "Dexvra Raid", label: "Raid panel: group record line", ph: ["started", "completed"] },
  raid_sources_none: { group: "Dexvra Raid", label: "Raid panel: no X key at all", ph: [] },
  raid_sources_partial: { group: "Dexvra Raid", label: "Raid panel: no paid X key", ph: [] },
  raid_group_only: { group: "Dexvra Raid", label: "Error: raids run in a group", ph: [] },
  raid_admin_only: { group: "Dexvra Raid", label: "Error: group admins only", ph: [] },
  raid_status: { group: "Dexvra Raid", label: "Raid panel: auto-raid status lines", ph: ["handle", "when", "min", "reason"] },
  raid_watch_prompt: { group: "Dexvra Raid", label: "Auto-raid: ask for the X account", ph: [] },
  raid_watch_set: { group: "Dexvra Raid", label: "Auto-raid: account saved", ph: ["handle"] },
  raid_watch_cleared: { group: "Dexvra Raid", label: "Auto-raid: account removed", ph: [] },
  raid_watch_bad: { group: "Dexvra Raid", label: "Auto-raid: that isn't an X account", ph: [] },
  raid_notice_failed: { group: "Dexvra Raid", label: "Auto-raid: couldn't start (group notice)", ph: ["reason", "url"] },
  raid_notice_blind: { group: "Dexvra Raid", label: "Auto-raid: can't see X (group notice)", ph: [] },
  raid_help: { group: "Dexvra Raid", label: "Raid: how it works", ph: [] },
  raid_seturl_prompt: { group: "Dexvra Raid", label: "Raid: ask for the X post link", ph: [] },
  raid_bad_url: { group: "Dexvra Raid", label: "Raid: that isn't an X post link", ph: [] },
  raid_none_running: { group: "Dexvra Raid", label: "Raid: nothing running here", ph: [] },
  raid_already_running: { group: "Dexvra Raid", label: "Launch refused: one already running", ph: [] },
  raid_already_launching: { group: "Dexvra Raid", label: "Launch refused: already launching", ph: [] },
  raid_bad_post: { group: "Dexvra Raid", label: "Launch refused: bad post link", ph: [] },
  raid_no_goals: { group: "Dexvra Raid", label: "Launch refused: no goals set", ph: [] },
  raid_reposts_only: { group: "Dexvra Raid", label: "Launch refused: reposts need a paid key", ph: [] },
  // ⚠️ These two had NO META entry, so the editor filed them under "Other" and
  // labelled them with their raw key — reachable, and reading as machine
  // internals on the one screen an operator edits copy from. Every template
  // carries a human label now, and templatePremium pins it.
  listing_lookup_wait: { group: "Bot Messages", label: "Listing: reading the token's profile", ph: [] },
  flow_step_failed: { group: "Bot Messages", label: "Any flow: that step failed, send it again", ph: [] },
  massdm_disabled: { group: "Mass DM", label: "Mass DM: disabled", ph: [] },
  massdm_intro: { group: "Mass DM", label: "Mass DM: intro + price (ask CA)", ph: ["sol", "bnb", "eth"] },
  massdm_ca_invalid: { group: "Mass DM", label: "Mass DM: invalid CA", ph: [] },
  massdm_compose_prompt: { group: "Mass DM", label: "Mass DM: compose prompt", ph: ["chain", "amount"] },
  massdm_chain_unconfirmed: { group: "Mass DM", label: "Mass DM: chain unconfirmed (compose prompt)", ph: ["chain", "amount"] },
  massdm_preview: { group: "Mass DM", label: "Mass DM: preview / pay", ph: ["amount"] },
  massdm_media_none: { group: "Mass DM", label: "Mass DM: preview — no photo attached", ph: [] },
  massdm_media_on: { group: "Mass DM", label: "Mass DM: preview — photo attached", ph: ["kind"] },
  massdm_media_unpreviewable: { group: "Mass DM", label: "Mass DM: preview — photo would not render", ph: ["kind"] },
  massdm_media_prompt: { group: "Mass DM", label: "Mass DM: ask for the photo", ph: [] },
  massdm_media_not_photo: { group: "Mass DM", label: "Mass DM: text sent at the photo step", ph: [] },
  massdm_media_as_file: { group: "Mass DM", label: "Mass DM: image sent as a file", ph: [] },
  massdm_media_too_long: { group: "Mass DM", label: "Mass DM: text too long for a caption", ph: ["len", "limit"] },
  massdm_media_set: { group: "Mass DM", label: "Mass DM: photo attached", ph: ["kind", "caption"] },
  massdm_media_cleared: { group: "Mass DM", label: "Mass DM: photo removed", ph: [] },
  massdm_edit_prompt: { group: "Mass DM", label: "Mass DM: edit the message", ph: [] },
  massdm_received: { group: "Mass DM", label: "Mass DM: paid, in review", ph: ["ref"] },
  massdm_enqueue_failed: { group: "Mass DM", label: "Mass DM: enqueue failed", ph: ["ref"] },
  massdm_test_queued: { group: "Mass DM", label: "Mass DM: test queued", ph: [] },
  broadcast_addon_sending: { group: "Mass DM", label: "Broadcast add-on: sending now", ph: ["ref"] },
  broadcast_addon_queued: { group: "Mass DM", label: "Broadcast add-on: queued for review (legacy order)", ph: ["ref"] },
  broadcast_addon_failed: { group: "Mass DM", label: "Broadcast add-on: enqueue failed", ph: ["ref"] },
  massdm_done: { group: "Mass DM", label: "Mass DM: delivered receipt", ph: ["ref", "reach", "fail"] },
  post_listing_xpress: { group: "Channel Posts", label: "Post: Xpress Listing", ph: ["name", "symbol", "logoEmoji", "coinUrl", "xUrl", "tradeUrl", "chainEmoji", "chain", "address", "liq", "mcap", "price", "twitter", "website", "telegram", "site", "listing", "trending", "announce", "xlisting"] },
  post_listing_tiered: { group: "Channel Posts", label: "Post: Listing & Trending", ph: ["name", "symbol", "logoEmoji", "tierEmoji", "tier", "coinUrl", "xUrl", "tradeUrl", "chainEmoji", "chain", "address", "liq", "mcap", "price", "twitter", "website", "telegram", "site", "listing", "trending", "announce", "xlisting"] },
  post_trending: { group: "Channel Posts", label: "Post: Trending", ph: ["name", "symbol", "logoEmoji", "coinUrl", "xUrl", "tradeUrl", "chainEmoji", "chain", "address", "liq", "mcap", "price", "twitter", "website", "telegram", "site", "listing", "trending", "announce", "xlisting"] },
  post_banner: { group: "Channel Posts", label: "Post: Banner ad", ph: ["title", "slot", "linkUrl", "description", "address", "twitter", "website", "telegram", "xUrl", "site", "listing", "trending", "announce", "xlisting"] },
  post_rankup: { group: "Channel Posts", label: "Post: Rank-up alert", ph: ["chainEmoji", "symbol", "name", "rank", "gain", "change", "address", "coinUrl", "coinUrlLabel", "xUrl", "twitter", "website", "telegram", "site", "listing", "trending", "announce", "xlisting"] },
  post_pump: { group: "Channel Posts", label: "Post: Pump alert", ph: ["chainEmoji", "symbol", "name", "percent", "multiple", "firstMc", "lastMc", "chain", "address", "coinUrl", "coinUrlLabel", "xUrl", "twitter", "website", "telegram", "site", "listing", "trending", "announce", "xlisting"] },
  post_gainers: { group: "Channel Posts", label: "Post: Top Gainers banner", ph: ["date", "list", "count", "xUrl", "site", "listing", "trending", "announce", "xlisting"] },
  tier_emojis: { group: "Channel Posts", label: "Tier badges (Diamond → Bronze)", ph: [] },
  chain_emojis: { group: "Channel Posts", label: "Chain emoji (per network — channel posts + buy alerts)", ph: [] },
  x_listing: { group: "X Posts", label: "X post: Xpress listing", ph: ["name", "tag", "mention", "url", "address", "price", "mcap", "chain", "handle"] },
  x_listing_tiered: { group: "X Posts", label: "X post: Listing & Trending", ph: ["tierEmoji", "tier", "name", "tag", "mention", "url", "address", "price", "mcap", "chain", "handle"] },
  x_trending: { group: "X Posts", label: "X post: trending", ph: ["symbol", "name", "chain", "url", "tag", "mention", "handle"] },
  x_pump: { group: "X Posts", label: "X post: pump alert", ph: ["tag", "name", "mention", "percent", "firstMc", "lastMc", "url", "handle"] },
  x_rankup: { group: "X Posts", label: "X post: rank-up alert", ph: ["tag", "name", "mention", "rank", "gain", "chain", "url", "handle"] },
  x_banner: { group: "X Posts", label: "X post: banner ad", ph: ["title", "slot", "url", "site", "handle", "mention"] },
  x_gainers: { group: "X Posts", label: "X post: Top Gainers board", ph: ["list", "date", "site", "handle"] },
};

// ── Load / cache with auto-refresh ───────────────────────────────────────────
let cache = null;
let lastLoad = 0;
let emojiCache = null;
let emojiLoad = 0;

/** The template as WRITTEN — code default, or an admin's saved rewording. No
 *  emoji overlay applied. This is what an overlay entry is recorded against. */
function baseValue(key) {
  const saved = loadJSONSync(FILE, {});
  return saved[key] != null ? saved[key] : DEFAULTS[key] || "";
}

function loadEmojiOverlay() {
  const now = Date.now();
  if (emojiCache && now - emojiLoad < REFRESH_MS) return emojiCache;
  emojiCache = loadJSONSync(EMOJI_FILE, {});
  emojiLoad = now;
  return emojiCache;
}

/**
 * Re-apply an operator's swapped icons on top of whatever the code ships.
 *
 * Each entry is {i, from, to}: slot #i shipped `from`, show `to`. Resolution is
 * deliberately forgiving, because the template underneath moves:
 *
 *  • slot #i still holds `from` → that one. The ordinary case.
 *  • it does not → the first unclaimed slot that still holds `from`. A row added
 *    or removed ABOVE shifts every index below it, and losing an operator's
 *    icons because a line moved is exactly the brittleness this replaces.
 *  • `from` is gone from the template entirely → the entry is dropped. The row
 *    it belonged to no longer exists; there is nothing to recolour.
 *
 * Applied BACK TO FRONT so each splice leaves the offsets of the ones still to
 * come untouched.
 */
function applyEmojiOverlay(key, val) {
  const entries = loadEmojiOverlay()[key];
  if (!entries || !entries.length) return val;
  const list = listEmojisIn(val);
  const used = new Set();
  const jobs = [];
  for (const e of entries) {
    let idx = list[e.i] && list[e.i].char === e.from && !used.has(e.i) ? e.i : -1;
    if (idx < 0) idx = list.findIndex((x, n) => x.char === e.from && !used.has(n));
    if (idx < 0) continue;
    used.add(idx);
    jobs.push({ target: list[idx], to: e.to });
  }
  jobs.sort((a, b) => b.target.start - a.target.start);
  let out = val;
  for (const j of jobs) {
    try {
      out = spliceEmoji(out, j.target, j.to);
    } catch {
      /* a malformed entry must never take the template down with it */
    }
  }
  return out;
}

function loadAll() {
  const now = Date.now();
  if (cache && now - lastLoad < REFRESH_MS) return cache;
  const saved = loadJSONSync(FILE, {});
  const merged = { ...DEFAULTS, ...saved };
  const overlay = loadEmojiOverlay();
  for (const key of Object.keys(overlay)) {
    if (merged[key] != null) merged[key] = applyEmojiOverlay(key, merged[key]);
  }
  cache = merged;
  lastLoad = now;
  return cache;
}

function substitute(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
}

/** Resolve a template into a send-ready payload:
 *    { text, entities }  — markup default or admin-pasted premium-emoji template
 *    { html }            — legacy admin-saved HTML template
 *  message.js / channels/post.js accept this payload shape directly.
 *  Vars are handled per mode: in an ENTITY template, markup-bearing vars
 *  (socials/footer/postLinks/…) are pre-parsed into {text, entities} fragments
 *  so their links/emoji render instead of showing raw markup; in the legacy
 *  HTML mode every var is markup-stripped AND HTML-escaped so user values can
 *  neither leak markup nor break Telegram's HTML parser. */
function render(key, vars, opts) {
  const val = loadAll()[key] != null ? loadAll()[key] : DEFAULTS[key] || "";
  return renderValue(val, vars, opts);
}

/**
 * Dexvra's OWN destinations, available to EVERY template without the call site
 * having to pass them: {site} {listing} {trending} {announce} {xlisting} {bot}
 * {botName}. They are constants — the same values on every render — so the only
 * thing threading them through each caller ever achieved was that a template
 * gained a link and then rendered it blank until someone remembered to update
 * the one handler that renders it. An admin can now drop {xlisting} into ANY
 * template from @dexvraadminbot and it resolves, with no deploy.
 *
 * Explicit vars always win, so nothing that passes its own {site} changes.
 * Required lazily: config/constants reads process.env at load time and main.js
 * loads .env before it, an order a top-level require here would break.
 */
function baseVars() {
  try {
    const { SITE_URL, CHANNELS, BOT_USERNAME, X_LISTING_URL } = require("./config/constants");
    const tme = (c) => (String(c || "").startsWith("@") ? `https://t.me/${String(c).slice(1)}` : String(c || ""));
    return {
      site: SITE_URL,
      listing: tme(CHANNELS.listing),
      trending: tme(CHANNELS.trending),
      announce: tme(CHANNELS.announce),
      xlisting: X_LISTING_URL,
      bot: tme(`@${BOT_USERNAME}`),
      botName: `@${String(BOT_USERNAME).replace(/^@/, "")}`,
    };
  } catch {
    return {}; // constants unavailable (a unit test in isolation) — render bare
  }
}

/** Render a RESOLVED template value (markup string or {text, entities}) — the
 *  body of render() without the key lookup. channels/format.js uses it to
 *  render a template AFTER stripping social/tier lines the token lacks. */
function renderValue(rawVal, varsIn, opts) {
  // Dexvra's own links underneath whatever the caller passed (caller wins), so
  // {xlisting} & friends resolve in every template. Applied BEFORE dropEmptyLines
  // so a line carrying only {xlisting} counts as filled and survives.
  const vars = { ...baseVars(), ...(varsIn || {}) };
  // OPT-IN only. A blanket "drop lines whose placeholders are empty" also eats
  // a channel-post header like "🔥 **New Trending on Dexvra** {logoEmoji}" when
  // the token has no emoji — real copy, one empty placeholder. Channel posts do
  // their own, smarter stripping in channels/format.js; this is for the buyer
  // receipts, where every link line is exactly "label: {url}".
  const val = opts && opts.dropEmpty ? dropEmptyLines(rawVal, vars) : rawVal;
  if (val && typeof val === "object" && val.text != null) {
    // Admin-pasted template stored with real entity arrays (premium emoji kept).
    const rich = {};
    for (const k of Object.keys(vars || {})) {
      let v = vars[k];
      // Self-spacing vars ({socials}/{overview} end in "\n\n") double up when
      // an OLDER saved template still writes its own blank line after the
      // placeholder. Entity text can't be post-collapsed (offsets), so trim
      // the var's trailing newlines whenever the template supplies its own.
      if (typeof v === "string" && /\n+$/.test(v) && val.text.includes(`{${k}}\n`)) {
        v = v.replace(/\n+$/, "");
      }
      if (typeof v === "string" && v) {
        const p = premium.parse(v);
        rich[k] = p.entities.length ? p : v;
      } else {
        rich[k] = v;
      }
    }
    return premium.substituteEntities(val.text, val.entities, rich);
  }
  const s = String(val);
  if (!premium.hasPremiumMarkup(s) && premium.looksLikeHtml(s)) {
    // Legacy HTML template saved before the markup era — render as HTML with
    // markup-stripped, escaped values (links degrade to plain text: correct
    // beats broken).
    const safe = {};
    for (const k of Object.keys(vars || {})) {
      const v = vars[k];
      safe[k] = v == null ? "" : escapeHtml(premium.parse(String(v)).text);
    }
    return { html: collapseGaps(substitute(s, safe)) };
  }
  return premium.parse(collapseGaps(substitute(s, vars)));
}

// Self-spacing vars ({socials}/{overview} carry their own trailing "\n\n") can
// double up against an older saved template that still writes explicit blank
// lines around the placeholder — collapse 3+ newlines so both layouts render
// clean. String paths only: entity-saved templates can't be collapsed without
// remapping premium-emoji offsets, so they keep the admin's literal spacing.
function collapseGaps(s) {
  return String(s).replace(/\n{3,}/g, "\n\n");
}

/**
 * Drop every line whose placeholders ALL resolve to empty.
 *
 * This is what lets a receipt spell its links out as editable lines —
 * "🔔 Dexvra Trending: {trendingUrl}" — instead of hiding them behind one
 * auto-generated {postLinks} blob the operator cannot reword. An Xpress buyer
 * has no announcement and no trending post, so those lines have to disappear
 * completely rather than leave a label pointing at nothing.
 *
 * A line with no placeholders is never touched, and a line keeps its place as
 * long as ONE of its placeholders has a value. Works on both stored shapes: for
 * an admin-pasted {text, entities} template the entity offsets are re-mapped
 * around the removed lines, so premium emoji stay on their characters.
 */
function dropEmptyLines(val, vars) {
  const isEntity = val && typeof val === "object" && val.text != null;
  const text = isEntity ? val.text : String(val || "");
  if (!text.includes("{")) return val;
  const filled = (k) => vars && vars[k] != null && String(vars[k]) !== "";
  const lines = text.split("\n");
  const cuts = []; // [start, end) ranges to remove, in order
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = off;
    off += line.length + 1;
    const keys = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (!keys.length || keys.some(filled)) continue;
    // Take the line's own trailing newline so the gap closes behind it.
    cuts.push([start, i < lines.length - 1 ? start + line.length + 1 : start + line.length]);
  }
  if (!cuts.length) return val;
  // Merge touching/overlapping ranges — the offset maths below assumes disjoint
  // cuts, and two dropped neighbours would otherwise be counted twice.
  const merged = [];
  for (const [a, b] of cuts) {
    const prev = merged[merged.length - 1];
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b);
    else merged.push([a, b]);
  }
  cuts.length = 0;
  cuts.push(...merged);
  // A cut that runs to the end of the text has no newline of its own to take,
  // so it swallows the ones in front of it — including the blank separator that
  // introduced the block. Otherwise a receipt whose whole link block is empty
  // ends on dangling blank lines.
  const last = cuts[cuts.length - 1];
  if (last[1] === text.length) {
    const floor = cuts.length > 1 ? cuts[cuts.length - 2][1] : 0;
    while (last[0] > floor && text[last[0] - 1] === "\n") last[0]--;
  }
  const cut = (s) => cuts.reduceRight((acc, [a, b]) => acc.slice(0, a) + acc.slice(b), s);
  if (!isEntity) return cut(text);
  const removedBefore = (pos) => cuts.reduce((n, [a, b]) => (b <= pos ? n + (b - a) : n), 0);
  const inCut = (pos) => cuts.some(([a, b]) => pos >= a && pos < b);
  const entities = (val.entities || [])
    .filter((e) => !inCut(e.offset))
    .map((e) => ({ ...e, offset: e.offset - removedBefore(e.offset) }));
  return { ...val, text: cut(text), entities };
}

/**
 * A template's RAW MARKUP with its placeholders filled — for splicing one
 * template into another as a placeholder value.
 *
 * NOT t(), which strips the markup: a spliced-in fragment carrying a [link] or
 * **bold** would reach the reader as plain text, because the outer template is
 * parsed AFTER substitution and there is nothing left to parse. NOT render()
 * either — that returns a parsed payload whose entities the outer parse cannot
 * re-absorb.
 *
 * Base vars are applied here too, since the value is substituted into the outer
 * template as opaque text and the outer pass never re-scans it: a {bot} left
 * inside the fragment would reach the group as the literal characters "{bot}".
 *
 * Limitation, and it is why this is only used for short fragments: a template an
 * admin saved WITH premium-emoji entities contributes its text only — the custom
 * emoji are dropped, because their offsets cannot be remapped into the host.
 */
function markup(key, vars) {
  const all = loadAll();
  const val = all[key] != null ? all[key] : DEFAULTS[key] || "";
  const text = val && typeof val === "object" && val.text != null ? val.text : String(val);
  return substitute(text, { ...baseVars(), ...(vars || {}) });
}

/** Plain-text resolve (markup stripped to clean text) — for previews/tests. */
function t(key, vars) {
  const r = render(key, vars);
  return r.html != null ? r.html : r.text;
}

/** Raw (unsubstituted) current value — for the editor's "current" view.
 *  Entity-based templates return their text (entities noted by the editor). */
function getRaw(key) {
  const val = loadAll()[key] != null ? loadAll()[key] : DEFAULTS[key] || "";
  return val && typeof val === "object" && val.text != null ? val.text : String(val);
}
function getRawValue(key) {
  return loadAll()[key] != null ? loadAll()[key] : DEFAULTS[key] || "";
}
// ── Per-emoji editing ───────────────────────────────────────────────────────
// Editing a template means re-sending the WHOLE message, which is fine for
// rewording but absurd for swapping one emoji in a 12-line welcome card. These
// two functions let the admin bot list the emoji in a template and replace ONE
// of them in place — keeping every other character, and every other entity,
// exactly where it was.
//
// A template value comes in two shapes and both are handled here:
//   • markup string (all DEFAULTS)  — a premium emoji is "[😀](emoji/123)"
//   • {text, entities} (admin paste) — a premium emoji is a custom_emoji entity
//     over its fallback char, so replacing text in the middle means re-mapping
//     every entity offset after the cut.
const EMOJI_RE =
  /(?:\p{RI}\p{RI}|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*|[0-9#*]\uFE0F?\u20E3)/gu;
// The char half may contain NO markup-control character — the same rule (and
// set) premium.parse() enforces, so what this file lists as premium is exactly
// what the renderer will treat as premium. "[" would make the match on a
// NESTED fragment ("[[⚡](emoji/1) Trade](url)") swallow the outer link's
// opening bracket; "*"/"`" inside a char would let the parser's pattern scan
// cut a span through the middle of it.
const PREMIUM_FRAG_RE = /\[([^[\]()`*\n]+)\]\(emoji\/(\d+)\)/g;

/** Parse a replacement the admin sent: "😀" or "[😀](emoji/123)". */
function parseFragment(fragment) {
  const f = String(fragment || "").trim();
  const m = /^\[([^[\]()`*\n]+)\]\(emoji\/(\d+)\)$/.exec(f);
  return m ? { char: m[1], id: m[2] } : { char: f, id: null };
}

/**
 * Every SLOT a template's card can restyle, in reading order:
 *   { i, char, id, start, end }   — id set only for premium ones
 *
 * Built from the BASE value's structure (what the code ships, or the admin's
 * saved rewording) and DECORATED with the overlay — never scanned out of the
 * overlaid text. Scanning the result was how slots vanished: swap 💲 for a
 * custom emoji whose fallback is "Ⓢ" or "$" — not a pictographic char — and
 * the scanner stopped seeing it, so the picker lost the button while the card
 * kept the icon. Unfixable from the UI, and worse: every slot BELOW shifted
 * one index up, so the picker's buttons quietly edited the wrong rows.
 *
 * `i`/`start`/`end` are BASE coordinates — exactly what replaceEmojiAt()
 * resolves against, so a button always edits the slot it shows.
 */
function listEmojis(key) {
  // `baseChar` is the slot's IDENTITY — the glyph the code ships there. The
  // current char is only how the slot looks today: two different rows whose
  // swaps happen to share a fallback char are still two different slots.
  const base = listEmojisIn(baseValue(key)).map((e) => ({ ...e, baseChar: e.char }));
  const entries = loadEmojiOverlay()[key];
  if (!entries || !entries.length) return base;
  // The same forgiving resolution applyEmojiOverlay uses, so the picker shows
  // exactly the icons the card renders.
  const used = new Set();
  const shown = base.map((e) => ({ ...e }));
  for (const en of entries) {
    let idx = base[en.i] && base[en.i].char === en.from && !used.has(en.i) ? en.i : -1;
    if (idx < 0) idx = base.findIndex((x, n) => x.char === en.from && !used.has(n));
    if (idx < 0) continue;
    used.add(idx);
    const { char, id } = parseFragment(en.to);
    if (char) {
      shown[idx].char = char;
      shown[idx].id = id;
    }
  }
  return shown;
}

/** The same scan, against a VALUE rather than a key. Split out because the
 *  emoji overlay has to read a template's emoji while resolving that very
 *  template — going back through getRawValue() would recurse. */
function listEmojisIn(val) {
  const isEntity = val && typeof val === "object" && val.text != null;
  const text = isEntity ? val.text : String(val || "");
  const out = [];
  if (!isEntity) {
    // Premium fragments first — they own their whole "[char](emoji/id)" span,
    // so the plain scan below must not also match the char inside them.
    const taken = [];
    PREMIUM_FRAG_RE.lastIndex = 0;
    for (let m; (m = PREMIUM_FRAG_RE.exec(text)); ) {
      out.push({ char: m[1], id: m[2], start: m.index, end: m.index + m[0].length });
      taken.push([m.index, m.index + m[0].length]);
    }
    EMOJI_RE.lastIndex = 0;
    for (let m; (m = EMOJI_RE.exec(text)); ) {
      const at = m.index;
      if (taken.some(([a, b]) => at >= a && at < b)) continue;
      out.push({ char: m[0], id: null, start: at, end: at + m[0].length });
    }
  } else {
    const ce = (val.entities || []).filter((e) => e.type === "custom_emoji");
    EMOJI_RE.lastIndex = 0;
    for (let m; (m = EMOJI_RE.exec(text)); ) {
      const at = m.index;
      const hit = ce.find((e) => e.offset === at);
      out.push({ char: m[0], id: hit ? hit.custom_emoji_id : null, start: at, end: at + m[0].length });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out.map((e, i) => ({ i, ...e }));
}

/** One emoji swapped for another, in place, in a template VALUE. Pure. */
function spliceEmoji(val, target, fragment) {
  const { char, id } = parseFragment(fragment);
  if (!char) throw new Error("send a single emoji");
  const isEntity = val && typeof val === "object" && val.text != null;

  if (!isEntity) {
    const text = String(val || "");
    // A premium fragment goes in AS a fragment even inside a link label:
    // "[[⚡](emoji/1) Trade](url)" is what premium.parse() reads as a link with
    // a custom_emoji entity nested in it. It used to be downgraded to the plain
    // char here because the old single-pass parser choked on the nesting and
    // leaked literal brackets — which is why a premium swap on the ⚡ Trade /
    // 📈 Chart row looked like it silently failed.
    const replacement = id ? `[${char}](emoji/${id})` : char;
    return text.slice(0, target.start) + replacement + text.slice(target.end);
  }

  // Entity form: splice the text, then move every entity that sits after the
  // cut and stretch every entity that CONTAINS it. Getting this wrong slides
  // premium emoji onto the wrong characters — the bug this whole file guards.
  const text = val.text;
  const delta = char.length - (target.end - target.start);
  const next = [];
  for (const e of val.entities || []) {
    const end = e.offset + e.length;
    if (e.type === "custom_emoji" && e.offset === target.start && end === target.end) continue; // the old one
    if (end <= target.start) next.push({ ...e });
    else if (e.offset >= target.end) next.push({ ...e, offset: e.offset + delta });
    else next.push({ ...e, length: Math.max(0, e.length + delta) }); // spans the cut
  }
  if (id) next.push({ type: "custom_emoji", offset: target.start, length: char.length, custom_emoji_id: id });
  next.sort((a, b) => a.offset - b.offset);
  return { text: text.slice(0, target.start) + char + text.slice(target.end), entities: next };
}

/**
 * Replace emoji #i and persist. Returns the emoji list after the change, so the
 * caller can redraw its keyboard.
 *
 * THIS DOES NOT SAVE THE TEMPLATE. It records "the glyph that ships at slot #i
 * is shown as X instead", and the overlay is re-applied to whatever the code
 * ships. That distinction is the whole point:
 *
 * It used to write the entire rendered template into data/templates.json, so
 * changing ONE icon forked that card from every future release — permanently
 * and invisibly. Ship a copy fix and the server keeps the old card; the operator
 * pulls, restarts, checks the boot sha, and the change is still not there. That
 * happened, and it looked exactly like a deploy that had not landed.
 *
 * It is also how "{💎}" reached a customer's group: a full-text rewrite on every
 * swap is a rewrite that can go wrong, and one did.
 *
 * Rewording a template still saves text, as it must — that IS a fork, chosen on
 * purpose. Swapping an icon is not.
 */
async function replaceEmojiAt(key, i, fragment) {
  const { char } = parseFragment(fragment);
  if (!char) throw new Error("send a single emoji");
  // Recorded against the BASE glyph — what the code ships at that slot, not what
  // the operator is currently seeing there. Swapping the same slot twice then
  // replaces the entry instead of chaining X→Y→Z, and the entry stays meaningful
  // when the surrounding copy changes.
  const base = listEmojisIn(baseValue(key))[i];
  if (!base) throw new Error(`no emoji #${i + 1} in this template`);
  const all = loadJSONSync(EMOJI_FILE, {});
  const list = (all[key] || []).filter((e) => e.i !== i);
  list.push({ i, from: base.char, to: String(fragment) });
  list.sort((a, b) => a.i - b.i);
  all[key] = list;
  await saveJSON(EMOJI_FILE, all);
  emojiCache = null;
  cache = null;
  return listEmojis(key);
}

/** A value's text with every emoji blanked out — two templates share a skeleton
 *  when they differ ONLY in their icons. */
function emojiSkeleton(val) {
  const text = val && typeof val === "object" && val.text != null ? val.text : String(val || "");
  const list = listEmojisIn(text);
  let out = "";
  let at = 0;
  for (const e of list) {
    out += text.slice(at, e.start) + " ";
    at = e.end;
  }
  return out + text.slice(at);
}

/**
 * Un-fork the templates that were frozen before icon swaps had somewhere to go.
 *
 * Every existing server has full-text overrides in data/templates.json that the
 * operator never meant as a rewording — they tapped "😀 Swap emoji" and the old
 * code wrote the whole card. Those templates stopped following releases, which
 * is why a shipped copy fix could look exactly like a deploy that never landed.
 *
 * Converted ONLY when the saved text differs from the shipped default in
 * nothing but its emoji. That is the whole test, and it is a strict one: a
 * reworded card has a different skeleton and is left completely alone, because
 * an operator's own wording is theirs and must never be silently discarded.
 *
 * Entity-saved values are skipped too. Those come from pasting a message with
 * real formatting, which is a deliberate rewrite by definition.
 *
 * Idempotent — a second run finds nothing left to move.
 */
async function migrateEmojiOnlyOverrides() {
  const saved = loadJSONSync(FILE, {});
  const overlay = loadJSONSync(EMOJI_FILE, {});
  const moved = [];
  for (const key of Object.keys(saved)) {
    const def = DEFAULTS[key];
    if (typeof def !== "string" || typeof saved[key] !== "string") continue;
    if (overlay[key] && overlay[key].length) continue; // an overlay already speaks for this one
    if (emojiSkeleton(saved[key]) !== emojiSkeleton(def)) continue; // a real rewording — leave it
    const mine = listEmojisIn(saved[key]);
    const shipped = listEmojisIn(def);
    if (mine.length !== shipped.length) continue;
    const entries = [];
    for (let i = 0; i < shipped.length; i++) {
      if (mine[i].char === shipped[i].char && mine[i].id === shipped[i].id) continue;
      entries.push({ i, from: shipped[i].char, to: mine[i].id ? `[${mine[i].char}](emoji/${mine[i].id})` : mine[i].char });
    }
    if (entries.length) overlay[key] = entries;
    delete saved[key];
    moved.push(key);
  }
  if (!moved.length) return [];
  await saveJSON(EMOJI_FILE, overlay);
  await saveJSON(FILE, saved);
  emojiCache = null;
  cache = null;
  return moved;
}

/** Does this template carry a saved LAYOUT that no longer matches the shipped
 *  one? True only when there is something for adoptShippedLayout to do. */
function layoutDiffers(key) {
  const saved = loadJSONSync(FILE, {})[key];
  const def = DEFAULTS[key];
  if (typeof saved !== "string" || typeof def !== "string") return false;
  return emojiSkeleton(saved) !== emojiSkeleton(def);
}

/**
 * Take the shipped card's LAYOUT, keep the operator's ICONS.
 *
 * The case migrateEmojiOnlyOverrides deliberately refuses: a saved card that has
 * both swapped icons AND a row the shipped card no longer has. Pairing icons
 * across the whole template by position is guesswork once a row moves, so this
 * pairs them LINE BY LINE instead, matching each shipped line to the saved line
 * with the same emoji skeleton. A line whose icons were changed still matches,
 * because the skeleton is the text with the icons blanked out.
 *
 * What that buys: every icon lands back on the row it was chosen for, and a row
 * that no longer exists in the shipped card is simply not carried over.
 *
 * DELIBERATE, never automatic. It drops lines, and a line the OPERATOR added is
 * indistinguishable from a stale one left over from an older release — so this
 * is a button somebody presses, and it reports every line it dropped.
 *
 * @returns {{dropped: string[], carried: number}}
 */
async function adoptShippedLayout(key) {
  const def = DEFAULTS[key];
  const savedAll = loadJSONSync(FILE, {});
  const saved = savedAll[key];
  if (typeof def !== "string" || typeof saved !== "string") {
    throw new Error("this template has no saved text layout to replace");
  }
  const defLines = def.split("\n");
  const savedLines = saved.split("\n");
  const used = new Set();
  const entries = [];
  let at = 0; // running emoji index across the shipped template
  for (const dl of defLines) {
    const shipped = listEmojisIn(dl);
    const si = savedLines.findIndex((sl, n) => !used.has(n) && emojiSkeleton(sl) === emojiSkeleton(dl));
    if (si >= 0) {
      used.add(si);
      const mine = listEmojisIn(savedLines[si]);
      for (let k = 0; k < shipped.length; k++) {
        const m = mine[k];
        if (!m || (m.char === shipped[k].char && m.id === shipped[k].id)) continue;
        entries.push({ i: at + k, from: shipped[k].char, to: m.id ? `[${m.char}](emoji/${m.id})` : m.char });
      }
    }
    at += shipped.length;
  }
  const dropped = savedLines.filter((sl, n) => !used.has(n) && sl.trim());
  const overlay = loadJSONSync(EMOJI_FILE, {});
  if (entries.length) overlay[key] = entries;
  else delete overlay[key];
  delete savedAll[key];
  await saveJSON(EMOJI_FILE, overlay);
  await saveJSON(FILE, savedAll);
  emojiCache = null;
  cache = null;
  return { dropped, carried: entries.length };
}

function isCustom(key) {
  if (loadJSONSync(FILE, {})[key] != null) return true;
  const o = loadEmojiOverlay()[key];
  return !!(o && o.length);
}
/** Number of admin-saved overrides on disk — INCLUDING orphaned keys from
 *  older template generations (keys that no longer exist in DEFAULTS). The
 *  reset-all flow must offer to clear those too, or a data file holding only
 *  stale keys reads as "nothing to reset" while the file is not empty. */
function overrideCount() {
  const saved = Object.keys(loadJSONSync(FILE, {}));
  const overlay = Object.keys(loadJSONSync(EMOJI_FILE, {}));
  return new Set([...saved, ...overlay]).size;
}
/**
 * Placeholders the DEFAULT relies on that a saved value has lost.
 *
 * THE FAILURE THIS CATCHES: a group card went out reading "{💎}" where its size
 * row belongs. Something — a hand edit, an emoji pasted over the wrong span —
 * had turned `{emoji}` into `{💎}`, and nothing anywhere objected: a mangled
 * placeholder is just text, so it renders as text, in a customer's group, under
 * their ticker. The template editor is the only place that can notice, because
 * by the time an alert posts it is far too late.
 *
 * Reported, never rejected. An operator is allowed to drop a placeholder they
 * do not want — that is the whole point of editing — so this returns what
 * changed and lets the caller say so.
 */
function missingPlaceholders(key, value) {
  const def = DEFAULTS[key];
  if (typeof def !== "string") return [];
  const text = value && typeof value === "object" && value.text != null ? value.text : String(value || "");
  const names = (t) => new Set([...String(t).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  const had = names(def);
  const has = names(text);
  return [...had].filter((n) => !has.has(n));
}

/** A `{...}` whose contents are not a plain name — `{💎}`, `{emo ji}`. Always a
 *  mistake: nothing substitutes it, so it reaches the group verbatim. */
function mangledPlaceholders(value) {
  const text = value && typeof value === "object" && value.text != null ? value.text : String(value || "");
  return [...String(text).matchAll(/\{([^{}]{0,40})\}/g)].map((m) => m[0]).filter((m) => !/^\{\w+\}$/.test(m));
}

async function setTemplate(key, value) {
  const saved = loadJSONSync(FILE, {});
  saved[key] = value;
  await saveJSON(FILE, saved);
  cache = null; // force reload on next read
}
async function resetTemplate(key) {
  const saved = loadJSONSync(FILE, {});
  if (key in saved) {
    delete saved[key];
    await saveJSON(FILE, saved);
  }
  // The swapped icons go too. "Reset default" means the card as shipped, and an
  // operator who resets a template because it looks wrong is not asking to keep
  // the half of their edits that lives in another file.
  const overlay = loadJSONSync(EMOJI_FILE, {});
  if (key in overlay) {
    delete overlay[key];
    await saveJSON(EMOJI_FILE, overlay);
  }
  emojiCache = null;
  cache = null;
}

/** Wipe every admin-saved override → all templates revert to the code defaults.
 *  Returns how many custom templates were cleared. */
async function resetAllTemplates() {
  const saved = loadJSONSync(FILE, {});
  const overlay = loadJSONSync(EMOJI_FILE, {});
  const n = Object.keys(saved).length + Object.keys(overlay).length;
  await saveJSON(FILE, {});
  await saveJSON(EMOJI_FILE, {});
  emojiCache = null;
  cache = null;
  return n;
}

const keys = () => Object.keys(DEFAULTS);
const meta = (key) => META[key] || { group: "Other", label: key, ph: [] };
const groups = () => {
  const g = {};
  for (const k of keys()) (g[meta(k).group] ||= []).push(k);
  return g;
};

module.exports = {
  missingPlaceholders,
  mangledPlaceholders,
  baseValue,
  listEmojisIn,
  emojiSkeleton,
  migrateEmojiOnlyOverrides,
  layoutDiffers,
  adoptShippedLayout,
  applyEmojiOverlay,
  EMOJI_FILE,
  t,
  markup,
  render,
  renderValue,
  SOCIALS_BLOCK,
  FOOTER_BLOCK,
  getRaw,
  getRawValue,
  getBaseValue: baseValue,
  listEmojis,
  replaceEmojiAt,
  isCustom,
  overrideCount,
  setTemplate,
  resetTemplate,
  resetAllTemplates,
  keys,
  meta,
  groups,
  substitute,
  dropEmptyLines,
  DEFAULTS,
  BANNER_PATH,
  EMOJI: E,
  em,
};
