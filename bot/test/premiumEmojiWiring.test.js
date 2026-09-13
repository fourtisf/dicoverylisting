'use strict';
/*
 * premiumEmojiWiring.test.js — the E map has to actually reach the message.
 *
 * templates.js documents its own markup at the top ("[😀](emoji/1234567890)")
 * and carries an E map of 18 verified premium emoji ids. Every default template
 * calls `em(char, id)` to use them. But `em` was written `(emoji) => emoji`:
 * it took the id and threw it away, so all 34 call sites rendered the bare
 * unicode char and the whole map was dead code.
 *
 * Nothing errored. The loss is invisible for a char like 💎 or 🚨, whose
 * unicode art is already colourful — and obvious for 📢, whose premium art is a
 * different picture. That is the difference an operator spotted in the channel
 * footer, months after the fact.
 */
const test = require('node:test');
const assert = require('node:assert');
const t = require('../src/templates');

const V = { name: 'X', symbol: 'X', site: 'https://dexvra.io', listing: 'https://t.me/a',
  trending: 'https://t.me/b', announce: 'https://t.me/c', xlisting: 'https://x.com/d', xUrl: 'https://x.com/p' };
const ceOf = (r) => ((r && r.entities) || []).filter((e) => e.type === 'custom_emoji');

test('em() emits the markup its own file documents', () => {
  assert.strictEqual(t.em('📢', '123'), '[📢](emoji/123)');
  // No id is still valid — the char stands alone rather than becoming "(emoji/undefined)".
  assert.strictEqual(t.em('🔥'), '🔥');
  assert.strictEqual(t.em('🔥', null), '🔥');
});

test('a channel post carries the premium ids as entities', () => {
  for (const key of ['post_listing_tiered', 'post_trending', 'post_banner']) {
    const r = t.render(key, V);
    assert.ok(r && r.text, `${key} rendered nothing`);
    assert.ok(ceOf(r).length > 0, `${key} carries no custom_emoji entity — the E map is dead again`);
  }
});

test("the footer's own emoji are among them", () => {
  // 💎 Dexvra.io · 🚨 Listings · 🔥 Trending · 📢 Announcements — the row the
  // operator was looking at. 🔥 has no verified id and stays plain on purpose.
  const ids = new Set(ceOf(t.render('post_trending', V)).map((e) => e.custom_emoji_id));
  assert.ok(ids.has(t.EMOJI.diamond), '💎 lost its id');
  assert.ok(ids.has(t.EMOJI.sirenHead), '🚨 lost its id');
  assert.ok(ids.has(t.EMOJI.megaphone), '📢 lost its id — this is the one that was visibly wrong');
});

test('the markup never reaches the reader as literal text', () => {
  // If a template took the legacy-HTML branch, "[📢](emoji/123)" would be sent
  // verbatim. That branch is guarded on !hasPremiumMarkup; this proves it.
  for (const key of ['post_listing_tiered', 'post_trending', 'post_banner']) {
    const r = t.render(key, V);
    assert.ok(!/\]\(emoji\//.test(r.text), `${key} leaked raw emoji markup into the message text`);
  }
});

test('every id in the map is a plausible Telegram document id', () => {
  // A malformed id makes Telegram reject the WHOLE message with EMOJI_INVALID,
  // so a typo here costs the post, not just the emoji.
  for (const [k, id] of Object.entries(t.EMOJI)) {
    assert.match(String(id), /^[0-9]{15,20}$/, `${k} is not a numeric document id`);
  }
});
