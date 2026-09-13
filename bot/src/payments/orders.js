// Order persistence (data/orders.json) — restart-safe record of every payment
// intent + its serializable fulfilment payload. Unlike the reference bot (which
// keeps onSuccess only in memory), a paid-but-unfulfilled order can be recovered
// after a restart because its payload lives here.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "orders.json";
const orders = loadJSONSync(FILE, {});

async function saveOrder(o) {
  orders[o.id] = o;
  await saveJSON(FILE, orders);
}
function getOrder(id) {
  return orders[id] || null;
}
function allOrders() {
  return Object.values(orders);
}
async function setStatus(id, status, extra) {
  if (!orders[id]) return null;
  orders[id].status = status;
  orders[id].updatedAt = Date.now();
  if (extra) Object.assign(orders[id], extra);
  await saveJSON(FILE, orders);
  return orders[id];
}
/** Orders that took payment (paid) but haven't been fulfilled — recovery target. */
function unfulfilledPaid() {
  return Object.values(orders).filter((o) => o.status === "paid");
}

module.exports = { saveOrder, getOrder, allOrders, setStatus, unfulfilledPaid };
