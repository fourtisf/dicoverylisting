// Shared in-memory state, separate from Telegraf sessions (legacy-compatible
// with the fourtis `awaitingResponses` pattern). Lost on restart — anything that
// must survive a restart goes through helpers/persist.js instead.
module.exports = {
  awaitingResponses: {},
};
