// Premium-emoji markup engine (fourtis-compatible syntax):
//   [😀](emoji/5368324170671202286)  → Telegram custom (premium) emoji, 😀 fallback
//   **bold**                          → bold
//   [text](https://url)               → text link
//   `code`                            → inline code
// parse() produces clean text + Bot-API-shaped entities (UTF-16 offsets, the
// unit Telegram uses). toGramJs() converts them for MTProto sends.
//
// ⚠️ WHERE THEY ANIMATE IS A PROPERTY OF THE CHAT TYPE, NOT OF THE TRANSPORT,
// and this comment used to say otherwise. Telegram's rule is that a bot may use
// custom-emoji entities if it holds a Fragment username, OR "in the messages
// directly sent by the bot to private, group and supergroup chats if the OWNER
// of the bot has a Telegram Premium subscription".
//
//   CHANNEL (@dexvraio, the board)  → in neither list, so a regular bot's
//     entities are stripped: this is why channels/post.js reaches for the
//     GramJS premium USER account, and why 💎 Premium status exists.
//   PRIVATE chat (every bot card, and the Mass DM broadcast) → they animate
//     over the plain Bot API as soon as the BotFather owner has Premium.
//     Nothing in this repo has to do anything for that; the entities already
//     go out untouched, with no parse_mode.
//
// The old wording generalised the channel's restriction to every send, and a
// broadcast was reported as unable to do something it does by itself — a fact
// asserted in a comment outliving the fact, which this repo has paid for before
// (the "DexScreener does not index Robinhood" entry, in five files).

const PH_RE = /\{(\w+)\}/g;

/** Parse premium markup → { text, entities } (Bot API entity objects). */
function parse(input) {
  const raw = String(input == null ? "" : input);

  // Premium fragments are reduced to their bare char BEFORE the pattern scan,
  // wherever they sit. This is what lets one live INSIDE a link label or a bold
  // span: "[[⚡](emoji/1) Trade](url)" is unreadable to the link regex (the
  // label may not contain "]"), so a single-pass scan either lost the link or
  // leaked literal brackets into the card. Reduced first, the scan sees
  // "[⚡ Trade](url)" — plain and matchable — and the emoji survives as a
  // recorded position that becomes a custom_emoji entity NESTED in the link,
  // which is exactly the shape Telegram accepts.
  const marks = []; // { at: offset into `reduced`, char, id }
  let reduced = "";
  let last = 0;
  // The char may contain NO markup-control character — the same set
  // emojiFragment strips when it builds a fragment. "[" would make the match on
  // "[[⚡](emoji/1) Trade](url)" start one char early and swallow the outer
  // link's opening bracket; "*" or "`" inside the char would pair with
  // delimiters OUTSIDE the fragment after reduction, and the pattern scan
  // below would cut a span through the middle of the char — emitting an
  // entity past the end of the text, which Telegram rejects wholesale.
  const fragRe = /\[([^[\]()`*\n]+)\]\(emoji\/(\d+)\)/g;
  for (let f; (f = fragRe.exec(raw)) !== null; ) {
    reduced += raw.substring(last, f.index);
    marks.push({ at: reduced.length, char: f[1], id: f[2] });
    reduced += f[1];
    last = f.index + f[0].length;
  }
  reduced += raw.substring(last);

  // `pre` = delimiter chars before the visible text, so the spans the scan
  // strips ([start, start+pre) and [textEnd, end)) can be named exactly — the
  // premium marks below need them to know how far their char slid left.
  const patterns = [];
  let m;
  let r = /\*\*([^*]+)\*\*/g;
  while ((m = r.exec(reduced)) !== null)
    patterns.push({ type: "bold", start: m.index, end: m.index + m[0].length, text: m[1], pre: 2 });
  r = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((m = r.exec(reduced)) !== null)
    // A NEAR-MISS fragment — emoji-shaped but with a junk id ("[🔥](emoji/12x)")
    // or a malformed char — is not consumed by the pre-pass, and without this
    // guard it would become a text_link whose url is the relative "emoji/…",
    // which the Bot API refuses — failing the whole message. Left literal, the
    // typo is visible and the message still sends.
    if (!m[2].startsWith("emoji/"))
      patterns.push({ type: "text_link", start: m.index, end: m.index + m[0].length, text: m[1], url: m[2], pre: 1 });
  r = /`([^`\n]+)`/g;
  while ((m = r.exec(reduced)) !== null)
    patterns.push({ type: "code", start: m.index, end: m.index + m[0].length, text: m[1], pre: 1 });

  patterns.sort((a, b) => a.start - b.start || b.end - a.end);
  const entities = [];
  const kept = [];
  let clean = "";
  let lastEnd = 0;
  for (const p of patterns) {
    if (p.start < lastEnd) continue; // overlapping match (e.g. link inside bold) — keep the first
    clean += reduced.substring(lastEnd, p.start);
    const offset = clean.length; // UTF-16 code units — what Telegram expects
    clean += p.text;
    const e = { type: p.type, offset, length: p.text.length };
    if (p.type === "text_link") e.url = p.url;
    entities.push(e);
    kept.push(p);
    lastEnd = p.end;
  }
  clean += reduced.substring(lastEnd);

  // Place each premium mark into `clean`: its char slid left by every delimiter
  // the scan removed before it. A mark whose char TOUCHES a removed span (a
  // URL, a `**`) is not intact in `clean` — dropped whole rather than emitted
  // over the wrong characters. And a mark inside a `code` span keeps its char
  // but no entity: Telegram allows nothing nested inside code, and an illegal
  // shape can fail the whole send.
  for (const mk of marks) {
    const mkEnd = mk.at + mk.char.length;
    let removed = 0;
    let gone = false;
    for (const p of kept) {
      const textStart = p.start + p.pre;
      const textEnd = textStart + p.text.length;
      if (p.type === "code" && mk.at >= textStart && mk.at < textEnd) gone = true;
      for (const [a, b] of [[p.start, textStart], [textEnd, p.end]]) {
        if (b <= mk.at) removed += b - a;
        else if (a < mkEnd && mk.at < b) gone = true;
      }
    }
    if (gone) continue;
    entities.push({ type: "custom_emoji", offset: mk.at - removed, length: mk.char.length, custom_emoji_id: mk.id });
  }
  // Offset order, containing entity first — the shape clients and GramJS expect
  // for nested entities.
  entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text: clean, entities };
}

/** Convert Bot-API-shaped entities to GramJS Api entities. `Api` is injected so
 *  this module never requires the heavy `telegram` package itself. */
function toGramJs(entities, Api) {
  const out = [];
  for (const e of entities || []) {
    if (e.type === "custom_emoji" && e.custom_emoji_id)
      out.push(new Api.MessageEntityCustomEmoji({ offset: e.offset, length: e.length, documentId: BigInt(e.custom_emoji_id) }));
    else if (e.type === "bold") out.push(new Api.MessageEntityBold({ offset: e.offset, length: e.length }));
    else if (e.type === "italic") out.push(new Api.MessageEntityItalic({ offset: e.offset, length: e.length }));
    else if (e.type === "text_link" && e.url) out.push(new Api.MessageEntityTextUrl({ offset: e.offset, length: e.length, url: e.url }));
    else if (e.type === "url") out.push(new Api.MessageEntityUrl({ offset: e.offset, length: e.length }));
    else if (e.type === "code") out.push(new Api.MessageEntityCode({ offset: e.offset, length: e.length }));
    else if (e.type === "pre") out.push(new Api.MessageEntityPre({ offset: e.offset, length: e.length, language: e.language || "" }));
    else if (e.type === "underline") out.push(new Api.MessageEntityUnderline({ offset: e.offset, length: e.length }));
    else if (e.type === "strikethrough") out.push(new Api.MessageEntityStrike({ offset: e.offset, length: e.length }));
    else if (e.type === "spoiler") out.push(new Api.MessageEntitySpoiler({ offset: e.offset, length: e.length }));
    // unknown types (mention/hashtag/…) are display-only — safe to drop on re-send
  }
  return out;
}

/** Substitute {placeholders} in an ENTITY template (admin-pasted message with
 *  premium emoji), shifting entity offsets so formatting stays glued to the
 *  right characters. All arithmetic is UTF-16 code units. Values are inserted
 *  literally — placeholders inside a substituted value are NOT re-expanded.
 *  A var value may itself be a {text, entities} payload (a pre-parsed markup
 *  fragment, e.g. socials/footer/postLinks): its text is inserted and its
 *  entities merged in at the insertion offset — so links/emoji inside built
 *  vars survive inside admin-pasted templates instead of showing raw markup. */
function substituteEntities(text, entities, vars) {
  let out = String(text == null ? "" : text);
  const ents = (entities || []).map((e) => ({ ...e }));
  PH_RE.lastIndex = 0;
  let m;
  while ((m = PH_RE.exec(out)) !== null) {
    const key = m[1];
    const raw = vars ? vars[key] : null;
    const isRich = raw != null && typeof raw === "object" && raw.text != null;
    const rep = raw == null ? "" : isRich ? String(raw.text) : String(raw);
    const start = m.index;
    const phLen = m[0].length;
    const delta = rep.length - phLen;
    out = out.slice(0, start) + rep + out.slice(start + phLen);
    // 1. shift/trim the template's OWN entities around the replacement…
    for (const e of ents) {
      const end = e.offset + e.length;
      if (e.offset >= start + phLen) e.offset += delta; // fully after → shift
      else if (end <= start) {
        /* fully before → untouched */
      } else if (e.offset <= start && end >= start + phLen) e.length += delta; // spans it → stretch
      else if (e.offset >= start && end <= start + phLen) e.length = 0; // inside it → drop
      else if (e.offset < start) e.length = start - e.offset; // straddles left edge → truncate
      else {
        const cut = start + phLen - e.offset; // straddles right edge → move past the value
        e.offset = start + rep.length;
        e.length = Math.max(0, e.length - cut);
      }
    }
    // 2. …then merge the fragment's own entities at the insertion offset.
    if (isRich && Array.isArray(raw.entities)) {
      for (const e of raw.entities) ents.push({ ...e, offset: e.offset + start });
    }
    PH_RE.lastIndex = start + rep.length; // never re-scan the inserted value
  }
  return { text: out, entities: ents.filter((e) => e.length > 0) };
}

/** True when the string uses premium-emoji markup. */
function hasPremiumMarkup(s) {
  return /\]\(emoji\/\d+\)/.test(String(s || ""));
}

/** fourtis-style forgiveness gate: real HTML tags only — a bare `&` or `<` in
 *  normal copy ("Listing & Trending") must NOT flip a template into HTML mode. */
function looksLikeHtml(s) {
  return /<\/?(b|i|u|s|a|code|pre|blockquote|tg-emoji|tg-spoiler)\b[^>]*>/i.test(String(s || ""));
}

/** Neutralize markup-control characters in USER-supplied values (token names,
 *  symbols, overviews, titles) before they're substituted into a markup
 *  template — else a name like "[click](https://scam)" would inject a link
 *  into channel posts. `**` runs are broken with U+2217 (∗, visually near-
 *  identical): a user overview containing "100**" would otherwise open a bold
 *  span that swallows every later emoji/link/code pattern in the post,
 *  leaking raw "[📊](emoji/…)" markup into the official channel text. Lone
 *  asterisks survive — a single '*' can't form the '**' delimiter. */
function sanitizeVar(v) {
  // ALL asterisks become U+2217 — a lone '*' in a value substituted inside a
  // template's own **bold** span still pairs with the template delimiters and
  // leaks literal markers (review finding), so runs-only breaking isn't enough.
  return String(v == null ? "" : v)
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/`/g, "'")
    .replace(/\*/g, "∗");
}

/** Neutralize markup delimiters in URLs interpolated into [label](url) — a ')'
 *  in a user URL would close the link early and inject arbitrary markup into
 *  official channel posts. Percent-encoding keeps the link working. */
function sanitizeUrl(v) {
  return String(v == null ? "" : v)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D")
    .replace(/`/g, "%60");
}

// Entity types an admin actually AUTHORS (formatting/premium emoji). Telegram
// also auto-detects url/bot_command/mention/hashtag/email/phone/cashtag on any
// plain message — those alone must NOT flip a typed template into verbatim
// {text, entities} storage (which would freeze its markup as literal text).
const AUTHORED_TYPES = new Set([
  "custom_emoji",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
  "code",
  "pre",
  "text_link",
  "blockquote",
]);
function hasAuthoredFormatting(entities) {
  return (entities || []).some((e) => AUTHORED_TYPES.has(e.type));
}

/** Guarantee a `code` entity over every occurrence of `value` in a rendered
 *  payload — Telegram's clients copy a monospace run to the clipboard when it
 *  is tapped, which is the whole reason a deposit address is formatted at all.
 *
 *  Applied at SEND time, not left to the template: the defaults do wrap the
 *  address in backticks, but an operator who re-saves the pay card from the
 *  admin bot pastes plain text, the entity is gone, and the buyer is left
 *  hand-typing a 44-character address. Formatting the money-critical value is
 *  not the operator's decision to lose.
 *
 *  A range already covered by ANY entity is left alone — code cannot nest
 *  inside bold/italic (Telegram rejects the combination), and an operator who
 *  bolded the address chose that. The Copy button covers that case. */
function ensureCode(payload, ...values) {
  if (!payload || typeof payload !== "object") return payload;
  const wanted = values.map((v) => String(v == null ? "" : v)).filter((v) => v.length > 1);
  if (!wanted.length) return payload;

  if (payload.html != null) {
    let html = String(payload.html);
    for (const v of wanted) {
      if (!html.includes(v) || html.includes(`<code>${v}</code>`)) continue;
      html = html.split(v).join(`<code>${v}</code>`);
    }
    return { ...payload, html };
  }

  const text = String(payload.text || "");
  const entities = [...(payload.entities || [])];
  const overlaps = (off, len) =>
    entities.some((e) => e.offset < off + len && off < e.offset + (e.length || 0));
  for (const v of wanted) {
    // indexOf counts UTF-16 code units — the unit Telegram entities use.
    for (let i = text.indexOf(v); i !== -1; i = text.indexOf(v, i + v.length)) {
      if (!overlaps(i, v.length)) entities.push({ type: "code", offset: i, length: v.length });
    }
  }
  entities.sort((a, b) => a.offset - b.offset);
  return { ...payload, entities };
}

/**
 * Append a rendered BLOCK to a rendered PAYLOAD, carrying the block's own
 * entities across.
 *
 * ⚠️ THIS IS WHAT KEEPS A PASTED PREMIUM EMOJI ALIVE ON AN ENFORCED LINE.
 * An enforced line is one the card must carry whether or not the operator's
 * saved template mentions it — the network on the pay card, the broadcast
 * add-on beneath it, the Mass DM attachment row. Every one of those built its
 * line from a plain STRING, so a 💎 pasted into the template behind it was
 * flattened to its fallback glyph: a custom_emoji lives in the ENTITIES and a
 * string has none. Render the row whole and append it, and they travel — the
 * rule the Mass DM attachment row already had to learn one handler over, and
 * the reason there is now ONE appender rather than a third private copy.
 *
 * Appended at the END, which is what makes it safe: Telegram entity offsets are
 * UTF-16 code units counted from the start, so nothing already in the payload
 * moves and only the block's own offsets shift.
 *
 * ⚠️ `seen` IS A SEAM, NOT DECORATION. The "already there" test is the block's
 * own rendered text by default — right for a row an operator cannot have typed
 * — but the network line tests a PHRASE instead, because `Network: <name>` is
 * what the template emits and the whole line is not. Folding the two together
 * would either re-append the network line onto every card that carries it or
 * let a bare mention suppress it, and this file has already paid for the second
 * one ("we accept Ethereum, Solana and BNB" names no network for THIS order).
 *
 * A legacy `html` card cannot carry entities at all, so the block goes in as
 * its html (or its text) there: losing the premium emoji beats losing the line.
 */
function appendBlock(payload, block, opts) {
  if (!payload || typeof payload !== "object") return payload;
  if (!block || typeof block !== "object") return payload;
  const add = String(block.text != null ? block.text : block.html || "");
  if (!add) return payload;
  const seen = opts && opts.seen != null ? String(opts.seen) : add;
  if (payload.html != null) {
    const html = String(payload.html);
    const asHtml = String(block.html != null ? block.html : add);
    if (html.includes(seen) || html.includes(asHtml)) return payload;
    return { ...payload, html: `${html}\n\n${asHtml}` };
  }
  const text = String(payload.text || "");
  if (text.includes(seen)) return payload;
  const shift = text.length + 2; // the "\n\n" join
  return {
    ...payload,
    text: `${text}\n\n${add}`,
    entities: [
      ...(payload.entities || []),
      ...(block.entities || []).map((e) => ({ ...e, offset: e.offset + shift })),
    ],
  };
}

module.exports = {
  ensureCode,
  appendBlock,
  parse,
  toGramJs,
  substituteEntities,
  hasPremiumMarkup,
  looksLikeHtml,
  sanitizeVar,
  sanitizeUrl,
  hasAuthoredFormatting,
};
