// Admin template editor — the group menu must PAGINATE. A flat keyboard for a
// large family (Bot Messages ships 37 templates) is 38 single-button rows, which
// Telegram rejects on editMessageText → tapping the group silently did nothing.
// These pin: no menu keyboard is ever oversized, and every page is reachable.
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123:TEST";

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const { _menu } = require("../src/admin/adminBot");

const rowsOf = (kb) => kb.reply_markup.inline_keyboard;
const flat = (kb) => rowsOf(kb).flat();

test("no group keyboard exceeds a safe Telegram row count on any page", () => {
  for (const name of _menu.groupNames()) {
    const slug = _menu.slugOf(name);
    const total = tpl.groups()[name].length;
    const pages = Math.max(1, Math.ceil(total / _menu.GROUP_PAGE));
    for (let p = 0; p < pages; p++) {
      const kb = _menu.groupKb(slug, p);
      // template rows (≤ GROUP_PAGE) + optional nav row + Back row
      assert.ok(rowsOf(kb).length <= _menu.GROUP_PAGE + 2, `${name} page ${p}: ${rowsOf(kb).length} rows`);
    }
  }
});

test("Bot Messages (the big family) actually paginates and every template is reachable", () => {
  const name = "Bot Messages";
  const slug = _menu.slugOf(name);
  const keys = tpl.groups()[name];
  assert.ok(keys.length > _menu.GROUP_PAGE, "Bot Messages should span multiple pages");
  const pages = Math.ceil(keys.length / _menu.GROUP_PAGE);
  const seen = new Set();
  for (let p = 0; p < pages; p++) {
    for (const b of flat(_menu.groupKb(slug, p))) {
      if (b.callback_data && b.callback_data.startsWith("v:")) seen.add(b.callback_data.slice(2));
    }
  }
  for (const k of keys) assert.ok(seen.has(k), `template ${k} is not reachable in any page`);
});

test("nav buttons carry the group slug + target page (regex-parseable)", () => {
  const slug = _menu.slugOf("Bot Messages");
  const nav = flat(_menu.groupKb(slug, 1)).map((b) => b.callback_data);
  // prev → page 0, next → page 2
  assert.ok(nav.includes(`grp:${slug}:0`), `prev page missing: ${nav.join(",")}`);
  assert.ok(nav.includes(`grp:${slug}:2`), `next page missing: ${nav.join(",")}`);
  // the handler regex must accept the paged callback form
  const re = /^grp:([a-z0-9]+)(?::(\d+))?$/;
  assert.ok(re.test(`grp:${slug}:2`) && re.test(`grp:${slug}`));
});

test("a single-page group shows no nav row", () => {
  const small = _menu.groupNames().find((n) => tpl.groups()[n].length <= _menu.GROUP_PAGE);
  assert.ok(small, "expected at least one small group");
  const cbs = flat(_menu.groupKb(_menu.slugOf(small), 0)).map((b) => b.callback_data);
  assert.ok(!cbs.includes("noop"), "small group should not render pager buttons");
});

test("main menu exposes a one-tap reset-all-templates action", () => {
  const cbs = flat(_menu.mainKb()).map((b) => b.callback_data);
  assert.ok(cbs.includes("resetall"), `reset-all button missing: ${cbs.join(",")}`);
});
