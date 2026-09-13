const test = require("node:test");
const assert = require("node:assert");
const fss = require("node:fs");
const path = require("node:path");
const tpl = require("../src/templates");

test("substitute replaces placeholders and blanks missing ones", () => {
  assert.strictEqual(tpl.substitute("{a}-{b}", { a: "1", b: "2" }), "1-2");
  assert.strictEqual(tpl.substitute("hi {name}!", { name: "Bob" }), "hi Bob!");
  assert.strictEqual(tpl.substitute("x {missing} y", {}), "x  y"); // missing → empty
});

test("t() renders a channel-post template with real values", () => {
  const out = tpl.t("post_pump", {
    name: "Jimothy",
    symbol: "$JIM",
    percent: 137,
    firstMc: "$310K",
    lastMc: "$128M",
    address: "So1...",
    coinUrl: "https://dexvra.io/x",
    footer: "",
  });
  assert.ok(out.includes("$JIM"));
  // The pump card is a ticker now: the market-cap MOVE, not a labelled table.
  assert.ok(out.includes("$310K") && out.includes("$128M"), out);
  assert.ok(out.includes("So1..."), "the CA is in the post");
});

test("every default template key has editor metadata + a group", () => {
  // The allowed group names are read from the admin bot's own icon map rather
  // than duplicated here. That was the actual coupling all along: a category
  // the editor has no icon for renders a button with a blank glyph, and a
  // second hardcoded list only ever catches a typo by ALSO having to be edited
  // — which makes it a chore that gets rubber-stamped, not a check.
  const admin = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");
  const map = admin.slice(admin.indexOf("const GROUP_ICON = {"), admin.indexOf("const slugOf"));
  const known = new Set([...map.matchAll(/"([^"]+)":\s*"/g)].map((m) => m[1]));
  assert.ok(known.size >= 5, "the icon map was found and parsed");
  for (const k of tpl.keys()) {
    const m = tpl.meta(k);
    assert.ok(m.label, `missing label for ${k}`);
    assert.ok(known.has(m.group) || m.group === "Other", `${k} is in group "${m.group}", which has no icon in adminBot GROUP_ICON`);
  }
  const g = tpl.groups();
  assert.ok(g["Bot Messages"].length > 0);
  assert.ok(g["Channel Posts"].length >= 4); // listing/trending/pump/banner
});

test("t() falls back to default for an unknown key without throwing", () => {
  assert.strictEqual(tpl.t("does_not_exist", {}), "");
});

test("every template group is menu-reachable via a unique slug (admin editor)", () => {
  const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "") || "grp";
  const groups = Object.keys(tpl.groups());
  // the families the bot now ships MUST each be their own editable group
  for (const g of ["Bot Messages", "Channel Posts", "Mass DM", "Group Buy Bot", "Dexvra Raid"]) {
    assert.ok(groups.includes(g), `admin editor is missing the '${g}' group`);
  }
  // slugs are unique (callback-data collisions would hide a group)
  const slugs = groups.map(slug);
  assert.strictEqual(new Set(slugs).size, slugs.length, "duplicate group slugs");
  // every template resolves to a listed group (nothing orphaned)
  for (const k of tpl.keys()) assert.ok(groups.includes(tpl.meta(k).group), `${k} in an unlisted group`);
});
