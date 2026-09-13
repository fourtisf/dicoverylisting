// Network defaults applied before anything opens a socket.
//
// This VPS's IPv6 route to Telegram is flaky. pm2 logs show, over and over:
//   WARN  [start] setMyCommands failed: … connect ETIMEDOUT 2001:67c:4e8:f004::9:443
//   ERROR [telegraf] message handler error: Promise timed out after 120000 ms
// Both are the same stall seen from different ends: 2001:67c:4e8:f004::9 is
// api.telegram.org over IPv6, and a user who taps a button gets nothing for two
// minutes while the connection waits out a dead route.
//
// Node resolves names "verbatim" — in the order the resolver returns them,
// which puts the AAAA record first — so every Telegram call pays that timeout
// before anything falls back to IPv4. Asking for IPv4 first sidesteps it
// entirely; IPv6 still works for hosts that only have it.
//
// DNS_RESULT_ORDER=verbatim restores Node's own default if the route is ever
// repaired or IPv6 becomes required.
const dns = require("node:dns");
const log = require("./logger");

function preferIPv4() {
  const order = process.env.DNS_RESULT_ORDER || "ipv4first";
  if (order === "verbatim") return;
  try {
    dns.setDefaultResultOrder(order);
  } catch (e) {
    log.warn(`[net] DNS result order "${order}" not applied: ${e.message}`);
  }
}

module.exports = { preferIPv4 };
