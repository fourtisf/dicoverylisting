// One-off MongoDB connection tester. Run on the VPS to confirm MONGO_URI is
// valid — reachable, right credentials, read/write works — BEFORE restarting the
// bots. Fail-open means a bad URI just drops the bot back to local files, so this
// catches a typo/IP-allowlist problem loudly instead of it failing silently.
//
//   node scripts/mongo-check.js                       # reads MONGO_URI from .env
//   node scripts/mongo-check.js "mongodb+srv://..."   # test a URI without editing .env
//
// This answers "can I connect?", NOT "is my state actually backed up?". For the
// second — every store in sync / stale / never mirrored, and how many premium
// emoji are at risk — run `npm run backup:check`.
// One owner for "which .env does this process read" — repo root, then bot/, then
// the cwd, with override. dotenv on its own resolves against the CWD alone, so
// four scripts here quietly disagreed about which file counted.
require("../src/config/loadEnv").loadEnv();
const { MongoClient } = require("mongodb");

const uri = process.argv[2] || process.env.MONGO_URI || "";
if (!uri) {
  console.error("❌ No MONGO_URI. Put it in .env, or pass it as an argument:");
  console.error('   node scripts/mongo-check.js "mongodb+srv://dexvra:PASS@host/dexvra?retryWrites=true&w=majority"');
  process.exit(1);
}

// Never print the password back to the terminal / logs.
const redacted = uri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)[^@]+@/, "$1****@");

(async () => {
  const started = Date.now();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
  try {
    console.log(`… connecting to ${redacted}`);
    await client.connect();
    const db = client.db(process.env.MONGO_DB || undefined);
    await db.command({ ping: 1 });
    console.log(`✅ Connected in ${Date.now() - started}ms — database: ${db.databaseName}`);

    // Prove read/write perms with a throwaway doc, then clean it up.
    const t = db.collection("_dexvra_healthcheck");
    await t.updateOne({ _id: "ping" }, { $set: { at: new Date() } }, { upsert: true });
    const doc = await t.findOne({ _id: "ping" });
    await t.deleteOne({ _id: "ping" });
    console.log(`✅ Read/write OK${doc ? "" : " (write ok, read returned nothing?)"}`);

    const cols = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith("_"));
    console.log(`   collections: ${cols.length ? cols.join(", ") : "(none yet — created on first bot boot)"}`);
    console.log("\n🎉 MONGO_URI is valid. Safe to set it in .env and restart the bots.");
    console.log("   Then confirm your state actually reached it:  npm run backup:check");
    process.exit(0);
  } catch (e) {
    console.error(`\n❌ Connection FAILED: ${e && e.message}`);
    console.error("\nMost common causes:");
    console.error("  1. Network Access — add THIS server's IP (or 0.0.0.0/0) in Atlas → Network Access → IP Access List");
    console.error("  2. Wrong username/password in the URI");
    console.error("  3. Missing the /dexvra database name before the '?' in the URI");
    console.error("  4. Cluster still provisioning — wait until Atlas shows it as active");
    process.exit(1);
  } finally {
    await client.close().catch(() => {});
  }
})();
