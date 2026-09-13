// Smoke test for the Phase 1 UI: drives every view and the behavior
// checklist from docs/HANDOFF.md section 7 against a running server.
//   BASE_URL=http://localhost:3000 CHROMIUM_PATH=... node scripts/e2e-smoke.mjs
// Note: "1h %" header check reads innerText, which is uppercased by CSS —
// compared case-insensitively for that reason.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
import { mkdirSync } from "node:fs";
const SHOT_DIR = process.env.SHOT_DIR ?? "e2e-shots";
mkdirSync(SHOT_DIR, { recursive: true });
const SHOT = (n) => `${SHOT_DIR}/${n}.png`;
const results = [];
const check = (name, ok, extra = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

let browser;
try {
browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => results.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") results.push(`CONSOLE-ERROR: ${m.text().slice(0, 200)}`); });

// ---------- HOME ----------
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector(".board .row:not(.head)", { timeout: 15000 });
check("home board rows render", (await page.locator(".board .row:not(.head)").count()) >= 10);
check("ticker items render", (await page.locator(".tick-item").count()) >= 8);
// the Moontok arrangement: the intel cards LEAD the page — above the board,
// with the heat, gauge and news cards all present
check("intel cards lead the page", await page.evaluate(() => {
  const strip = document.querySelector(".pulse-strip");
  const board = document.querySelector(".board");
  return !!strip && !!board && strip.getBoundingClientRect().top < board.getBoundingClientRect().top;
}));
check("pulse heat cells", (await page.locator(".heat-cell").count()) === 3);
check("fear&greed gauge", await page.locator(".fg-num").isVisible());
check("wire items", (await page.locator(".wire-item").count()) >= 1);
check("demo pill shown (no egress)", await page.locator(".src-pill.demo").isVisible());
// The boards must be pannable BY A FINGER, which needs computed overflow-x:auto
// — a later CSS layer once set a bare overflow:hidden on .board and the table
// went dead to touch while board.scrollLeft still worked programmatically, so
// every source-text pin stayed green. Only the computed style tells the truth.
check("boards keep computed overflow-x:auto", await page.evaluate(() => {
  const ox = (sel) => getComputedStyle(document.querySelector(sel)).overflowX;
  return ox(".sec-block .board") === "auto" && ox(".tc-board") === "auto";
}));
// Every cell must LIVE inside its own track — at PHONE width, where the fixed
// track templates apply. The Score cell holds two chips and is flex-end, so a
// track narrower than its content overflows LEFT: the DXS chip was drawn over
// the tail of the right-aligned Txns numbers, visible only mid-scroll on a
// phone ("perbaiki tampilan dx scorenya"). This runs HERE, not in the MOBILE
// section at the bottom — the script stops at the dead /new-pairs route before
// reaching it, and a guard in dead code guards nothing.
{
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(BASE, { waitUntil: "networkidle" });
  await m.waitForSelector(".board .row:not(.head)");
  check("phone: score chips fit their track, clear of the txns column", await m.evaluate(() => {
    const row = document.querySelector(".sec-block .board .row:not(.head)");
    const tx = row.querySelector(".c-txns").getBoundingClientRect();
    const info = row.querySelector(".c-info");
    const ds = info.querySelector(".dscore").getBoundingClientRect();
    const chips = [...info.children].reduce((s, c) => s + c.getBoundingClientRect().width, 0);
    return ds.left >= tx.right && chips <= info.getBoundingClientRect().width + 1;
  }));
  await m.close();
}
await page.screenshot({ path: SHOT("01-home"), fullPage: false });

// period tab changes column header
await page.click('.trend-frames .ttab:has-text("1h")');
const chgHead = await page.locator(".row.head .sortable").nth(1).innerText();
check("period tab changes header to 1h %", chgHead.toLowerCase().includes("1h %"), chgHead.replace(/\n/g, " "));

// chain filter — ONE control for the whole market area (movers + board + Top
// Coins), and it offers only chains that have listings, so there is no filter
// that can only ever empty the board.
await page.click('.chain-row .chain-chip:has-text("Solana")');
await page.waitForTimeout(300);
const chainRows = await page.locator(".board .row:not(.head)").count();
check("solana filter reduces rows", chainRows > 0 && chainRows < 20, `rows=${chainRows}`);
check("…and the movers with it", (await page.locator(".mv-card").first().locator(".mv-row").count()) <= chainRows);
check("…and Top Coins with it", (await page.locator(".tc-row:not(.tc-head)").count()) <= chainRows);
check("every offered chain carries its count", (await page.locator(".chain-chip .chain-n").count()) >= 2);
// "+N more" must DELIVER the N it promises. It once promised "+18 more" and
// rendered four — the label counted the hidden list while the render ignored
// it, and only clicking the button could tell.
const morePromise = Number(((await page.locator(".chain-more").innerText()).match(/\d+/) ?? [0])[0]);
const beforeMore = await page.locator(".chain-chip:not(.chain-more)").count();
await page.click(".chain-more");
await page.waitForTimeout(250);
const afterMore = await page.locator(".chain-chip:not(.chain-more)").count();
check("+N more delivers exactly N", afterMore - beforeMore === morePromise, `${beforeMore} → ${afterMore}, promised +${morePromise}`);
check("…including the registry's empty chains, dimmed", (await page.locator(".chain-zero").count()) > 0);
await page.click(".chain-more");
await page.waitForTimeout(200);
await page.click('.chain-row .chain-chip:has-text("All chains")');
await page.waitForTimeout(300);

// ---------- HOME MARKET AREA ----------
// Movers · trending board · Top Coins. These are DRIVEN rather than read: the
// one bug this section exists for — "Show all" passing limit 0 into a slice,
// which returned the EMPTY array and rendered the "no readable market cap"
// state over fourteen priced tokens — is invisible to any check that only
// asserts the markup is present.
check("three mover cards", (await page.locator(".mv-card").count()) === 3);
check("the mover list SCROLLS rather than growing the card", await page.evaluate(() => {
  const l = document.querySelector(".mv-list");
  return l.scrollHeight > l.clientHeight && getComputedStyle(l).overflowY === "auto";
}));
// A Top Loser must be DOWN and a Top Gainer UP — on a one-sided market the
// card is empty, never filled with the least-green token wearing a plus sign.
const signs = await page.evaluate(() =>
  [...document.querySelectorAll(".mv-card")].slice(0, 2).map((c) =>
    [...c.querySelectorAll(".mv-pct")].map((p) => p.className.includes("up"))));
check("every Top Gainer row is up", signs[0].every(Boolean), `${signs[0].length} rows`);
check("every Top Loser row is down", signs[1].every((u) => !u), `${signs[1].length} rows`);

// The board opens on ten and grows in place. The bar must deliver EXACTLY the
// number it names — a "Show all 40" that stops at 15 is a silent cap wearing a
// label, which is the one failure this whole footer exists to prevent.
const openRows = await page.locator(".board .row:not(.head)").count();
check("the home board opens on ten rows", openRows === 10, `${openRows}`);
const barLabel = (await page.locator(".board-expand").innerText()).replace(/\s+/g, " ").trim();
check("the expander names a number", /show all \d+ trending/i.test(barLabel), barLabel);
await page.click(".board-expand");
await page.waitForTimeout(350);
const grown = await page.locator(".board .row:not(.head)").count();
check("the tap delivers exactly what it promised", grown === Number(barLabel.match(/\d+/)[0]), `${openRows} → ${grown}`);
check("…and offers the way back", (await page.locator(".board-expand").innerText()).toLowerCase().includes("less"));
// Anything past the expander's ceiling still needs the full board; with a
// short seed there is nothing left over, so the line is correctly absent.
const leftover = await page.locator(".board-foot").count();
check("no 'showing N of M' line when the expander showed everything", leftover === 0, `${leftover}`);
await page.click(".board-expand");
await page.waitForTimeout(300);
check("collapses back to ten", (await page.locator(".board .row:not(.head)").count()) === 10);

// Top Coins: a third ranking, and it expands in place
const byCap = await page.locator(".tc-row:not(.tc-head) .tc-sym-txt").first().innerText();
await page.click('.tc-sorts .ttab:has-text("DXS Score")');
await page.waitForTimeout(300);
check("DXS Score ranks differently from Market Cap", (await page.locator(".tc-row:not(.tc-head) .tc-sym-txt").first().innerText()) !== byCap);
await page.click('.tc-sorts .ttab:has-text("Market Cap")');
await page.waitForTimeout(250);
const capped10 = await page.locator(".tc-row:not(.tc-head)").count();
await page.click(".tc-more");
await page.waitForTimeout(300);
const expanded = await page.locator(".tc-row:not(.tc-head)").count();
check("Show all EXPANDS the table", expanded > capped10, `${capped10} → ${expanded}`);
check("…and offers the way back", (await page.locator(".tc-more").innerText()).toLowerCase().includes("less"));
await page.click(".tc-more");
await page.waitForTimeout(250);
await page.screenshot({ path: SHOT("01b-home-market"), fullPage: false });

// sorting: click Price header → sorted desc by price.
// Asserted against the DATA rather than against a remembered ticker: the old
// form expected a "$1." leader and had been failing since the seed grew a
// $2.34 token, which is the sort working correctly.
await page.click('.row.head .sortable:has-text("Price")');
const prices = (await page.locator(".board .row:not(.head) .price").allInnerTexts())
  .map((t) => Number(t.replace(/[$,]/g, "")));
check("sort by price puts the dearest token first", prices[0] === Math.max(...prices), prices.slice(0, 3).join(" "));

// star does NOT open modal (stopPropagation)
await page.locator(".board .row:not(.head)").first().locator(".star").click();
await page.waitForTimeout(400);
check("star click doesn't open detail modal", (await page.locator(".modal-ov.on").count()) === 0);
check("toast shows on star", (await page.locator(".toast.on").innerText()).includes("watchlist"));

// row click opens the token PAGE. It was a modal once; `openDetail` has been
// `router.push(tokenHref(t))` for long enough that this check had drifted into
// waiting 3s for a `.modal-ov` nothing renders any more, taking the whole
// script down with it before it reached any later view.
await page.locator(".board .row:not(.head)").first().click();
await page.waitForURL(/\/token\//, { timeout: 8000 });
await page.waitForSelector(".detail-head, .ca-box", { timeout: 8000 });
check("row click opens the token page", /\/token\//.test(page.url()), page.url());
check("token page has the CA box", await page.locator(".ca-box code").first().isVisible());
const buyHref = await page.locator('a[href^="https://"]').first().getAttribute("href");
check("buy is a deeplink", !!buyHref && buyHref.startsWith("https://"), buyHref ?? "");
await page.screenshot({ path: SHOT("02-token-page") });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector(".board .row:not(.head)");

// ---------- WATCHLIST ----------
await page.click('.nav a[href="/watchlist"]');
await page.waitForSelector(".view");
await page.waitForTimeout(600);
check("watchlist has starred token", (await page.locator(".board .row:not(.head)").count()) === 1);
await page.screenshot({ path: SHOT("03-watchlist") });
// unstar → empty state
await page.locator(".board .row:not(.head) .star").click();
await page.waitForTimeout(400);
check("watchlist empty state", await page.locator(".big-empty").isVisible());

// ---------- NEW PAIRS ----------
await page.click('.nav a[href="/new-pairs"]');
await page.waitForSelector(".board.np .row:not(.head)");
const ages = await page.locator(".age-chip").allInnerTexts();
check("new pairs age chips", ages.length >= 10 && /⏱ \d+(m|h|d)/.test(ages[0]), ages.slice(0, 3).join(","));
await page.screenshot({ path: SHOT("04-newpairs") });

// ---------- TRENDING ----------
await page.click('.nav a[href="/trending"]');
await page.waitForSelector(".board .row:not(.head)");
await page.click('.ttab:has-text("Top Losers")');
const firstChg = await page.locator(".board .row:not(.head)").first().locator(".chg").innerText();
check("top losers shows negative first", firstChg.startsWith("-"), firstChg);

// ---------- ALL COINS ----------
await page.click('.nav a[href="/all-coins"]');
await page.waitForSelector(".board .row:not(.head)");
await page.fill('input[placeholder="Filter by name or ticker…"]', "frog");
await page.waitForTimeout(300);
check("all coins filter works", (await page.locator(".board .row:not(.head)").count()) === 1);

// ---------- SEARCH ----------
await page.click('.nav a[href="/search"]');
await page.click(".qtag >> nth=0");
await page.waitForTimeout(300);
check("search qtag fills results", (await page.locator(".board .row:not(.head)").count()) >= 1);

// ---------- SCANNER ----------
await page.click('.nav a[href="/scanner"]');
await page.click('button:has-text("Try a demo CA")');
await page.waitForSelector(".verdict", { timeout: 15000 });
const verdict = await page.locator(".verdict").innerText();
check("scanner returns verdict with DYOR framing", verdict.includes("DYOR"), verdict);
await page.screenshot({ path: SHOT("05-scanner") });

// ---------- CALCULATOR ----------
await page.click('.nav a[href="/calculator"]');
const mult = await page.locator(".calc-out .co .v").first().innerText();
check("calculator default 33.3x", mult === "33.3×", mult);
await page.fill('.frow input[type="number"] >> nth=0', "1000");
const val = await page.locator(".calc-out .co .v.dim").innerText();
check("calculator reacts to input", val === "$33,333", val);

// ---------- LISTING FLOW ----------
await page.click(".fasttrack");
await page.waitForSelector(".modal-ov.on");
// step 1 validation: empty submit
await page.click('button:has-text("Choose tier →")');
check("listing validates empty form", (await page.locator(".toast.on").innerText()).includes("Fill in"));
await page.fill('input[placeholder="e.g. Trench Cat"]', "Test Token");
await page.fill('input[placeholder="e.g. TRENCHCAT"]', "TEST");
await page.fill('input[placeholder="Paste CA…"]', "badaddress123456789012345");
await page.click('button:has-text("Choose tier →")');
check("listing validates CA per chain", (await page.locator(".toast.on").innerText()).includes("Solana address"));
await page.fill('input[placeholder="Paste CA…"]', "7xKqDF3PaGbTVrN8mJcE2WqHs5uYtRvKnZpXeAd9fQ");
await page.click('button:has-text("Choose tier →")');
await page.waitForSelector(".tier-grid", { timeout: 3000 });
check("listing step 2 tiers visible", (await page.locator(".tier-grid .tier").count()) === 3);
await page.click('.tier:has-text("Fast-Track")');
await page.click('button:has-text("Review →")');
check("review shows tier", (await page.locator(".check-list").innerText()).includes("Fast-Track"));
await page.click('button:has-text("Pay & submit ⚡")');
await page.waitForSelector(".success-wrap");
check("listing success step", await page.locator(".success-ic").isVisible());
await page.screenshot({ path: SHOT("06-listing-success") });
await page.click('button:has-text("View my listings →")');
await page.waitForURL("**/account");
check("account shows listing IN REVIEW", (await page.locator(".mini-listing").innerText()).includes("IN REVIEW"));
await page.screenshot({ path: SHOT("07-account") });

// ---------- ALERTS ----------
await page.click('.nav a[href="/alerts"]');
await page.click('button:has-text("Create alert")');
await page.waitForTimeout(300);
check("alert created", (await page.locator(".alert-item").count()) === 1);

// ---------- TOPBAR SEARCH + "/" KEY ----------
await page.keyboard.press("/");
const focused = await page.evaluate(() => document.activeElement?.getAttribute("placeholder"));
check("'/' focuses topbar search", focused === "Search token, pair, or paste CA…", focused ?? "none");
await page.keyboard.type("warchest");
await page.waitForURL(BASE + "/");
await page.waitForTimeout(400);
check("topbar search navigates home and filters", (await page.locator(".board .row:not(.head)").count()) === 1);

// ---------- MOBILE ----------
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: "networkidle" });
await mob.waitForSelector(".board .row:not(.head)");
check("mobile: sidebar hidden", !(await mob.locator(".sidebar").isVisible()));
check("mobile: topbar brand shown", await mob.locator(".brand-top").isVisible());
const hasHScroll = await mob.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
check("mobile: no horizontal scroll", !hasHScroll);
check("mobile: the movers are a swipeable rail, not three stacked blocks", await mob.evaluate(() => {
  const g = document.querySelector(".mv-grid");
  return g.scrollWidth > g.clientWidth && getComputedStyle(g).overflowX === "auto";
}));
await mob.screenshot({ path: SHOT("08-mobile-home"), fullPage: false });

// ---------- REDUCED MOTION ----------
const rm = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
await rm.goto(BASE, { waitUntil: "networkidle" });
await rm.waitForSelector(".board .row:not(.head)");
const anim = await rm.evaluate(() => getComputedStyle(document.querySelector(".ticker-track")).animationName);
check("reduced motion kills ticker animation", anim === "none", anim);

// ---------- PWA ----------
const mf = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).status);
check("manifest served", mf === 200);
const sw = await page.evaluate(async () => (await fetch("/sw.js")).status);
check("service worker served", sw === 200);

} catch (e) { results.push("SCRIPT-ERROR: " + e.message.split("\n")[0]); }
if (browser) await browser.close();
console.log(results.join("\n"));
process.exitCode = results.some(r => r.startsWith("FAIL") || r.startsWith("SCRIPT-ERROR")) ? 1 : 0;
