// GramJS (MTProto, user-account) channel sender — the ONLY way premium custom
// emoji actually render (a Telegram Premium USER session posts them; a regular
// bot gets them silently stripped). Mirrors fourtis' channels.js client
// lifecycle: string session on disk, 5-min cooldown after a failure, never
// interactive inside the bot process (scripts/gramjs-login.js creates the
// session once). Everything here is best-effort: callers fall back to Bot API.
const fss = require("node:fs");
const fs = require("node:fs/promises");
const { API_ID, API_HASH, GRAMJS_SESSION_FILE, GRAMJS_ENABLED } = require("./config/constants");
const premium = require("./premium");
const { loadJSONSync, saveJSON } = require("./helpers/persist");
const log = require("./helpers/logger");

let TG = null; // lazy-loaded 'telegram' module (heavy) — only when actually used
let client = null;
let clientFailedAt = 0;
let connecting = null; // in-flight getClient(), memoized — never two clients on one session
const CLIENT_COOLDOWN_MS = 5 * 60 * 1000;

// Cross-process premium-emoji status. Only the MAIN bot connects (two MTProto
// clients on one session string risks AUTH_KEY_DUPLICATED, which would revoke
// the login and kill premium posting outright), so it publishes what it learned
// into the shared data dir and the ADMIN bot reads it for /premium. Small file,
// written only when something actually changes.
const STATUS_FILE = "gramjsStatus.json";
function lastStatus() {
  const s = loadJSONSync(STATUS_FILE, null);
  return s && typeof s === "object" ? s : null;
}
const STATUS_KEYS = ["ok", "account", "premium", "error", "emojiRefused", "postError"];
function recordStatus(patch) {
  const prev = lastStatus() || {};
  const next = { ...prev, ...patch, at: Date.now() };
  // Skip the write when nothing meaningful moved (posts are frequent, this is
  // a diagnostic, and every saveJSON also fans out to the Mongo mirror).
  const same = STATUS_KEYS.every((k) => prev[k] === next[k]);
  if (same && prev.at) return;
  saveJSON(STATUS_FILE, next).catch(() => {});
}
/** Called when Telegram rejects our custom emoji — the single most useful
 *  signal for "why is the board plain?", and it outranks a stale getMe. */
function recordEmojiRefusal(error) {
  recordStatus({ emojiRefused: true, emojiError: String(error || "") });
}
// A connected, Premium account still posts nothing if it can't write to the
// channel — being an admin there is a property of the USER account, not of the
// bot that's already an admin. That failure is silent from the channel (the
// board just falls back to Bot API and looks unchanged), so record it.
function recordPostFailure(channel, err) {
  recordStatus({ postError: `${channel}: ${(err && err.message) || err}` });
}
function recordPostOk() {
  recordStatus({ postError: null });
}

function lib() {
  if (TG === undefined) return null;
  if (TG) return TG;
  try {
    TG = require("telegram");
  } catch (e) {
    log.warn(`[gramjs] 'telegram' package unavailable: ${e.message}`);
    TG = undefined;
    return null;
  }
  return TG;
}

/** Cheap availability check — config + session file present (no connect). */
function available() {
  if (!GRAMJS_ENABLED || !API_ID || !API_HASH) return false;
  if (clientFailedAt && Date.now() - clientFailedAt < CLIENT_COOLDOWN_MS) return false;
  try {
    return fss.existsSync(GRAMJS_SESSION_FILE) && fss.statSync(GRAMJS_SESSION_FILE).size > 10;
  } catch {
    return false;
  }
}

async function connectClient() {
  const t = lib();
  if (!t) throw new Error("telegram package not installed");
  try {
    const session = (await fs.readFile(GRAMJS_SESSION_FILE, "utf8")).trim();
    if (!session) throw new Error(`empty session file ${GRAMJS_SESSION_FILE} — run: node scripts/gramjs-login.js`);
    const { TelegramClient } = t;
    const { StringSession } = require("telegram/sessions");
    const c = new TelegramClient(new StringSession(session), API_ID, API_HASH, {
      connectionRetries: 5,
      timeout: 30,
    });
    // GramJS is chatty: every connect/disconnect at INFO, plus a full stack dump
    // whenever its 9s keep-alive ping times out (routine on a reconnect). That
    // floods pm2 logs and hides our own [gramjs]/[trendposter] lines. Keep real
    // errors, route the rest through our logger; GRAMJS_LOG_LEVEL overrides.
    try {
      c.setLogLevel(process.env.GRAMJS_LOG_LEVEL || "error");
      c.onError = async (err) => log.debug(`[gramjs] client: ${err && err.message}`);
    } catch {
      /* older GramJS without these setters — just keep the defaults */
    }
    await c.connect();
    // Never call start()'s interactive auth flow in the bot process: with a
    // revoked/expired session its signInUser() retries in a while(1) microtask
    // loop unless onError returns truthy — which would still mean auth we can't
    // do headless. Check authorization explicitly and bail to Bot API instead.
    // (This exact freeze was reproduced in review: a dead session starved the
    // whole event loop mid-fulfilment, after funds were swept.)
    let authorized = false;
    try {
      authorized = await c.checkAuthorization();
    } catch {
      authorized = false;
    }
    if (!authorized) {
      try {
        await c.disconnect();
      } catch {
        /* already down */
      }
      throw new Error("session unauthorized/revoked — run scripts/gramjs-login.js again");
    }
    client = c;
    clientFailedAt = 0;
    dialogsWarmed = false; // new client → new entity cache
    // WHO is posting, and can they send custom emoji at all? Telegram only lets
    // PREMIUM accounts do that — a non-premium login is the difference between
    // an animated board and a plain one, and it's invisible from the channel.
    let account = null;
    let isPremium = null;
    try {
      const me = await c.getMe();
      account = me.username ? `@${me.username}` : [me.firstName, me.lastName].filter(Boolean).join(" ") || String(me.id);
      isPremium = Boolean(me.premium);
    } catch {
      /* identity is a nice-to-have; posting still works */
    }
    recordStatus({ ok: true, account, premium: isPremium, error: null, emojiRefused: false, emojiError: null });
    if (isPremium === false) {
      log.warn(
        `[gramjs] connected as ${account || "?"} but that account is NOT Telegram Premium — custom emoji will post as their plain fallback.`,
      );
    } else {
      log.info(`[gramjs] connected as ${account || "?"}${isPremium ? " (Premium ✓)" : ""} — premium emoji posting active`);
    }
    return client;
  } catch (e) {
    clientFailedAt = Date.now();
    recordStatus({ ok: false, error: e.message });
    if (client) {
      try {
        client.disconnect();
      } catch {
        /* already down */
      }
      client = null;
    }
    throw e;
  }
}

async function getClient() {
  if (client && client.connected) return client;
  if (clientFailedAt && Date.now() - clientFailedAt < CLIENT_COOLDOWN_MS) {
    throw new Error(`gramjs on cooldown (${Math.ceil((CLIENT_COOLDOWN_MS - (Date.now() - clientFailedAt)) / 1000)}s)`);
  }
  // Memoize the in-flight connect so concurrent posts never build two MTProto
  // clients on the same StringSession (AUTH_KEY_DUPLICATED risk).
  if (!connecting) {
    connecting = connectClient().finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

/** Invalidate the cached client after an auth-level failure so the next call
 *  (post-cooldown) re-reads session.txt — re-running gramjs-login.js then
 *  takes effect without a bot restart. */
function invalidateOnAuthError(err) {
  const m = String((err && (err.errorMessage || err.message)) || "");
  if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|USER_DEACTIVATED/i.test(m)) {
    if (client) {
      try {
        client.disconnect();
      } catch {
        /* already down */
      }
      client = null;
    }
    clientFailedAt = Date.now();
  }
}

// A FRESH string session has an EMPTY entity cache. `@username` still resolves
// (contacts.ResolveUsername), but a numeric/private channel id carries no
// access_hash, so getEntity() throws "Could not find the input entity for …"
// even when the account is an admin there — and the board silently falls back
// to the Bot API, i.e. plain unicode. Fetching the dialog list once fills that
// cache. Done lazily (only after a miss) so the normal path pays nothing.
let dialogsWarmed = false;
async function resolveTarget(c, channel) {
  try {
    return await c.getEntity(channel);
  } catch (e) {
    if (dialogsWarmed) throw e;
    dialogsWarmed = true;
    log.info(`[gramjs] ${channel} not in the session's entity cache (${e.message}) — loading dialogs once`);
    await c.getDialogs({ limit: 100 });
    return c.getEntity(channel);
  }
}

/** Resolve media into something GramJS can upload. Bot API file_ids are NOT
 *  usable over MTProto → null (caller falls back to Bot API). */
async function resolveFile(media) {
  const t = lib();
  if (!media || !t) return null;
  const { CustomFile } = require("telegram/client/uploads");
  if (typeof media === "object" && media.source != null) {
    const src = media.source;
    if (Buffer.isBuffer(src)) return new CustomFile("photo.png", src.length, "", src);
    if (typeof src === "string" && fss.existsSync(src)) return src; // local path
    return null;
  }
  if (typeof media === "string" && /^https?:\/\//.test(media)) {
    try {
      const res = await fetch(media, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return new CustomFile("photo.png", buf.length, "", buf);
    } catch {
      return null;
    }
  }
  return null; // bot-api file_id or unknown → not usable here
}

/** Extra document attributes for an upload. Telegram decides "plays inline" vs
 *  "file card" from DocumentAttributeAnimated — NOT from the extension — and
 *  GramJS never adds it (Utils.getAttributes only sets filename/video/audio), so
 *  an uploaded .gif arrived in the channel as a 783 KB DOCUMENT card instead of
 *  a playing GIF. Attributes merge by class, so this keeps the filename and (for
 *  mp4) video attributes GramJS derived. `undefined` = leave them untouched. */
function fileAttributes(mediaType, Api) {
  return mediaType === "animation" ? [new Api.DocumentAttributeAnimated()] : undefined;
}

/** Send a message/photo with premium-emoji entities to a channel the logged-in
 *  user can post in. Returns a Bot-API-shaped { message_id, chat } or throws. */
async function sendToChannel(channel, { text, entities, media, mediaType, replyTo, pin }) {
  try {
    const c = await getClient();
    const t = lib();
    const target = await resolveTarget(c, channel);
    const formattingEntities = premium.toGramJs(entities || [], t.Api);
    let sent;
    const file = media ? await resolveFile(media) : null;
    if (media && !file) throw new Error("media not gramjs-compatible");
    if (file) {
      const attributes = fileAttributes(mediaType, t.Api);
      sent = await c.sendFile(target, {
        file,
        caption: text || "",
        formattingEntities,
        replyTo: replyTo || undefined,
        forceDocument: false,
        attributes,
        workers: 1,
      });
    } else {
      sent = await c.sendMessage(target, {
        message: text || "",
        formattingEntities,
        replyTo: replyTo || undefined,
        linkPreview: false,
      });
    }
    // Pinning can fail on its own while the POST succeeded — the premium user
    // account is often an admin only for posting, and CHAT_ADMIN_REQUIRED here
    // means "no pin rights". That was invisible at debug level and looked
    // exactly like "the bot doesn't pin". Report it, and tell the caller so it
    // can pin with the BOT instead (pinning, unlike editing, is not restricted
    // to the message's author).
    let pinned = false;
    if (pin) {
      try {
        await c.pinMessage(target, sent.id, { notify: false });
        pinned = true;
      } catch (e) {
        log.warn(`[gramjs] pin ${channel}/${sent.id} failed (${e.message}) — will try the bot`);
      }
    }
    recordPostOk();
    return { message_id: sent.id, chat: { id: Number(target.id) || target.id }, pinned };
  } catch (e) {
    invalidateOnAuthError(e);
    if (!isPremiumEmojiError(e)) recordPostFailure(channel, e); // emoji refusal has its own field
    throw e;
  }
}

/** Pin a message (silently). Used to make sure the board we maintain is the one
 *  readers actually see at the top of the channel. */
async function pinChannelMessage(channel, messageId) {
  const c = await getClient();
  const target = await resolveTarget(c, channel);
  await c.pinMessage(target, messageId, { notify: false });
}

/** Delete a message this account posted. Best-effort — used so switching
 *  transports (or re-posting a board) never leaves a stale duplicate behind. */
async function deleteChannelMessage(channel, messageId) {
  try {
    const c = await getClient();
    const target = await resolveTarget(c, channel);
    await c.deleteMessages(target, [messageId], { revoke: true });
  } catch (e) {
    invalidateOnAuthError(e);
    throw e;
  }
}

/** Telegram refused the message BECAUSE of its custom (premium) emoji — the
 *  account isn't Premium, or an id is dead/unavailable. The caller should retry
 *  the same send without custom_emoji entities rather than change transport:
 *  the text is identical, so the board keeps its one message instead of
 *  spawning a duplicate under the other identity. */
function isPremiumEmojiError(err) {
  const m = String((err && (err.errorMessage || err.message)) || "");
  return /PREMIUM_ACCOUNT_REQUIRED|EMOJI_INVALID|EMOJI_NOT_FOUND|CUSTOM_EMOJI|DOCUMENT_INVALID/i.test(m);
}

/** Premium-emoji readiness — the answer to "why is the board still plain
 *  unicode?", which has several causes that look identical from the channel.
 *
 *  Deliberately does NOT connect: the admin bot is a separate process and a
 *  second MTProto client on the same session string risks AUTH_KEY_DUPLICATED,
 *  which revokes the login and takes premium posting down for real. Local config
 *  is checked directly (that covers the most common cause — no session at all);
 *  live facts come from what the MAIN bot recorded on its last connect/post. */
function diagnose() {
  const out = {
    enabled: GRAMJS_ENABLED,
    apiCreds: Boolean(API_ID && API_HASH),
    sessionFile: GRAMJS_SESSION_FILE,
    sessionPresent: false,
    libInstalled: Boolean(lib()),
    cooldownSec: clientFailedAt ? Math.max(0, Math.ceil((CLIENT_COOLDOWN_MS - (Date.now() - clientFailedAt)) / 1000)) : 0,
    last: lastStatus(), // { at, ok, account, premium, error, emojiRefused, emojiError }
  };
  try {
    out.sessionPresent = fss.existsSync(GRAMJS_SESSION_FILE) && fss.statSync(GRAMJS_SESSION_FILE).size > 10;
  } catch {
    out.sessionPresent = false;
  }
  return out;
}

/** Edit an existing message (text + premium-emoji entities) that the logged-in
 *  user posted — used to keep the pinned Trending board's custom emoji live.
 *  Returns a Bot-API-shaped { message_id } or throws. */
async function editChannelMessage(channel, messageId, { text, entities }) {
  try {
    const c = await getClient();
    const t = lib();
    const target = await resolveTarget(c, channel);
    const formattingEntities = premium.toGramJs(entities || [], t.Api);
    await c.editMessage(target, {
      message: messageId,
      text: text || "",
      formattingEntities,
      linkPreview: false,
    });
    recordPostOk();
    return { message_id: messageId, chat: { id: Number(target.id) || target.id } };
  } catch (e) {
    invalidateOnAuthError(e);
    if (!isPremiumEmojiError(e) && !/not modified/i.test(e.message || "")) recordPostFailure(channel, e);
    throw e;
  }
}

module.exports = {
  available,
  getClient,
  sendToChannel,
  editChannelMessage,
  deleteChannelMessage,
  pinChannelMessage,
  isPremiumEmojiError,
  recordEmojiRefusal,
  _fileAttributes: fileAttributes,
  diagnose,
  _resolveFile: resolveFile,
};
