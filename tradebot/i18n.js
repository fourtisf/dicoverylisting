'use strict';
/*
 * i18n.js — user-facing copy, in English and Indonesian.
 *
 * core.js has carried `user.lang` ('en' | 'id') plus getLang()/setLang() since the
 * schema was written, and exported both. NOTHING ever called them: every string in
 * telegram.js was a hardcoded English literal and there was no command, button or
 * flow that could change the setting. A large share of this bot's users trade in
 * Indonesian, and the bot answered all of them in English while its own store
 * claimed to know better. This module is the missing half.
 *
 * CONVENTIONS
 *   • Keys are `area.thing`, and BOTH languages live on the same line-block, so a
 *     translation that drifts is visible in the diff rather than discovered by a
 *     user. A key missing from `id` falls back to `en` — never to a blank message.
 *   • `{placeholders}` are substituted verbatim. Callers pass values that are
 *     ALREADY escaped/formatted, exactly as the surrounding telegram.js code does
 *     with esc() — this module adds no escaping of its own and must not, or
 *     pre-escaped HTML (<b>, <code>) would be double-escaped and render as markup.
 *   • Indonesian copy is written the way traders actually talk: "buy", "sell",
 *     "wallet", "slippage", "gas" and "token" stay in English because translating
 *     them ("dompet", "selip") reads as machine output to the people using this.
 */

const LANGS = ['en', 'id'];
const DEFAULT_LANG = 'en';
const LANG_LABEL = { en: '🇬🇧 English', id: '🇮🇩 Bahasa Indonesia' };

const S = {
  // ---------------------------------------------------------------- onboarding
  'start.title': {
    en: '👋 <b>Welcome to Dexvra Trade Bot</b>',
    id: '👋 <b>Selamat datang di Dexvra Trade Bot</b>',
  },
  'start.pitch': {
    en: 'Buy and sell tokens right here in Telegram — no website, no wallet app, no extension.',
    id: 'Beli dan jual token langsung dari Telegram — tanpa website, tanpa aplikasi wallet, tanpa extension.',
  },
  'start.steps.head': { en: '<b>Get started in 3 steps</b>', id: '<b>Mulai dalam 3 langkah</b>' },
  'start.steps.1': {
    en: '1️⃣ <b>Add funds.</b> Tap <b>📥 Get my deposit address</b> below and send some {native} to it.',
    id: '1️⃣ <b>Isi saldo.</b> Tap <b>📥 Ambil alamat deposit</b> di bawah, lalu kirim {native} ke alamat itu.',
  },
  'start.steps.2': {
    en: "2️⃣ <b>Pick a token.</b> Paste its contract address here — you'll get a live card with price, safety and your holdings.",
    id: '2️⃣ <b>Pilih token.</b> Paste alamat kontraknya di sini — kamu langsung dapat kartu live berisi harga, cek keamanan, dan posisi kamu.',
  },
  'start.steps.3': {
    en: "3️⃣ <b>Trade.</b> Tap Buy or Sell. That's it.",
    id: '3️⃣ <b>Trading.</b> Tap Buy atau Sell. Sesederhana itu.',
  },
  'start.custody': {
    en: '<i>Your wallet is created and secured for you — only you can withdraw. Never share your private key with anyone.</i>',
    id: '<i>Wallet kamu dibuat dan diamankan otomatis — hanya kamu yang bisa withdraw. Jangan pernah bagikan private key ke siapa pun.</i>',
  },
  'start.new': {
    en: '👇 A wallet was just created for you. Add funds to begin.',
    id: '👇 Wallet kamu baru saja dibuat. Isi saldo dulu untuk mulai.',
  },
  'start.returning': { en: "👇 Here's your wallet.", id: '👇 Ini wallet kamu.' },
  'start.deeplink.new': {
    en: '👋 <b>Welcome to Dexvra Trade Bot</b>\n\nA wallet was just created for you. To start trading, tap 💼 Wallets → 📥 to get your deposit address and add some funds. Here\'s the token you tapped 👇',
    id: '👋 <b>Selamat datang di Dexvra Trade Bot</b>\n\nWallet kamu baru saja dibuat. Untuk mulai trading, tap 💼 Wallets → 📥 buat ambil alamat deposit dan isi saldo. Ini token yang kamu tap 👇',
  },
  'start.deeplink.fail': {
    en: "⚠️ <b>Couldn't open that token just now.</b>\n\nTap to copy its contract and paste it here to try again 👇",
    id: '⚠️ <b>Token itu belum bisa dibuka sekarang.</b>\n\nTap untuk menyalin alamat kontraknya, lalu paste di sini buat coba lagi 👇',
  },

  // ---------------------------------------------------------------- chrome
  'common.cancelled': { en: 'Cancelled.', id: 'Dibatalkan.' },
  'common.sending': { en: '⏳ Sending…', id: '⏳ Mengirim…' },
  'common.unknown_input': {
    en: "🤔 I didn't recognise that.\n\nTo trade a token, paste its <b>contract address</b> here. Or tap a button below.",
    id: '🤔 Saya belum mengerti pesan itu.\n\nUntuk trading token, paste <b>alamat kontraknya</b> di sini. Atau tap salah satu tombol di bawah.',
  },

  // ---------------------------------------------------------------- wallets
  // The /wallet screen. Written so the ACTIVE wallet is the subject and every
  // other wallet is one line — the old version printed the active wallet twice
  // (once as a summary, once in the list) and both 42- and 44-character
  // addresses for every wallet, which on a phone buried the balances.
  'wal.title': { en: '💼 <b>Your wallets</b>', id: '💼 <b>Wallet kamu</b>' },
  // THE HEADER IS ONE NUMBER. It used to be four lines carrying three different
  // figures — "$508.02 here", "$1,843.99 across 5 of 10 wallets, every chain",
  // "$1,706.20 in coins · $137.79 in tokens" — two of which merely re-added the
  // third, and "5 of 10 wallets" read as "only 5 of your 10 wallets were
  // counted" when it meant "you have used 5 of 10 slots". Reported, fairly, as
  // "sangat membingungkan". Now: Total first (the headline), the active chain's
  // share under it with an explicit label, and the wallet-slot cap moved to the
  // ➕ Generate button where capacity is actually decided.
  'wal.total': {
    en: '💰 Total: <b>{usd}</b>',
    id: '💰 Total: <b>{usd}</b>',
  },
  // The two lines that exist because one number wearing a chain badge is not an
  // answer. Switched to Solana with the money on Robinhood Chain, the screen
  // said "🟣 Solana" and "$1,322.54" on consecutive lines and there was $0 of
  // Solana. `wal.on_chain` is the chain you picked; `wal.total_all` says out
  // loud that the other figure spans every chain.
  // …with the NATIVE amount beside the USD ("harus ada jumlah solananya brp"):
  // the coin count is the number a depositor checks against their own wallet.
  'wal.on_chain': {
    en: '{emoji} On {chain}: <b>{usd}</b> · <b>{amt} {native}</b>',
    id: '{emoji} Di {chain}: <b>{usd}</b> · <b>{amt} {native}</b>',
  },
  // …and never "$0.00 here" for a chain we simply could not reach. That is the
  // line that sends someone to check whether their deposit arrived.
  'wal.on_chain_unread': {
    en: "{emoji} On {chain}: <i>couldn't read it just now</i>",
    id: '{emoji} Di {chain}: <i>belum bisa dibaca sekarang</i>',
  },
  // No wallet count here. The list below IS the count, and every extra number
  // on the header line re-creates the confusion this rewrite removes.
  'wal.total_all': {
    en: '💰 Total: <b>{usd}</b> — every wallet, every chain',
    id: '💰 Total: <b>{usd}</b> — semua wallet, semua chain',
  },
  // ONE number, not two that re-add the total. "…in coins · …in tokens" was the
  // line that tipped the header into confusion: it restated the Total as a sum
  // the reader is invited to check. The coins half is implied.
  'wal.split': { en: '<i>incl. {tokens} in tokens</i>', id: '<i>termasuk {tokens} berupa token</i>' },
  // "total itu total dalam token apa aja" — the coins behind the Total, grouped
  // by symbol. The token share is the wal.split line; per-token detail is 🪙.
  'wal.assets': { en: '<i>Coins: {list}</i>', id: '<i>Koin: {list}</i>' },
  'wal.active_head': { en: '<b>Active wallet</b>', id: '<b>Wallet aktif</b>' },
  'wal.others_head': { en: '<b>Your other wallets</b>', id: '<b>Wallet kamu yang lain</b>' },
  // The per-wallet breakdown's unread marker. Counted, not vague: "some chains"
  // reads as a shrug where a number reads as a fact the total is missing.
  'wal.row_unread': { en: '⚠️ {chains} unread', id: '⚠️ {chains} tak terbaca' },
  'wal.tokens_row': { en: '🪙 Tokens', id: '🪙 Token' },
  'wal.empty_on': { en: '<i>Nothing yet on {chains}</i>', id: '<i>Belum ada isinya di {chains}</i>' },
  'wal.unread_on': {
    en: "<i>Couldn't reach {chains} — those are not counted above</i>",
    id: '<i>{chains} tidak bisa dihubungi — belum dihitung di atas</i>',
  },
  'wal.addr_evm': { en: 'Deposit on {chains}', id: 'Deposit di {chains}' },
  'wal.addr_sol': { en: 'Deposit on {chain}', id: 'Deposit di {chain}' },
  // The one genuinely actionable thing a zero balance tells you.
  'wal.no_gas': {
    en: "⚠️ <b>0 {native} on {chain}</b> — you can't buy or pay gas here until you deposit.",
    id: '⚠️ <b>0 {native} di {chain}</b> — belum bisa beli atau bayar gas di sini sampai kamu deposit.',
  },
  // …and when a DIFFERENT wallet has gas on that chain, name it. Without this,
  // the chain line above ("🟣 Solana — $700.00 here", every wallet) and the
  // warning ("0 SOL", this wallet) read as the screen contradicting itself.
  'wal.gas_elsewhere': {
    en: '<i>{wallet} has {amt} {native} here — tap it below to switch.</i>',
    id: '<i>{wallet} punya {amt} {native} di sini — tap di bawah untuk pindah ke situ.</i>',
  },
  'wal.orders': { en: '{n} open', id: '{n} order jalan' },
  // Named, never silent: a screen that quietly drops wallets reads as a screen
  // that lost them. Every rolled-up wallet still has its own button below.
  'wal.more': {
    en: '…and {n} more, holding {usd}. Their buttons are below.',
    id: '…dan {n} wallet lagi, isinya {usd}. Tombolnya ada di bawah.',
  },
  'wal.hint': {
    en: '<i>Tap a wallet to make it active · ✏️ rename · 📥 its address &amp; QR · 🗑 remove.</i>',
    id: '<i>Tap wallet untuk jadikan aktif · ✏️ ganti nama · 📥 alamat &amp; QR-nya · 🗑 hapus.</i>',
  },
  'wal.first_steps': {
    en: '<b>Three steps to your first trade 👇</b>\n1️⃣ Tap <b>📥</b> on a wallet and send it some {native}.\n2️⃣ Tap <b>🔄 Refresh</b> — you will see it land.\n3️⃣ Paste any token contract address to get a live card with a one-tap Buy.',
    id: '<b>Tiga langkah menuju trade pertama 👇</b>\n1️⃣ Tap <b>📥</b> di salah satu wallet, lalu kirim {native} ke situ.\n2️⃣ Tap <b>🔄 Refresh</b> — saldonya akan langsung kelihatan.\n3️⃣ Paste alamat kontrak token apa pun untuk dapat kartu live dengan tombol Buy sekali tap.',
  },
  'wal.keys_note': {
    en: '<i>One key per wallet. Every EVM chain shares the same 0x address; Solana has its own.</i>',
    id: '<i>Satu key per wallet. Semua chain EVM pakai alamat 0x yang sama; Solana punya alamatnya sendiri.</i>',
  },

  // ---------------------------------------------------------------- tokens
  // The cross-chain "what do I actually hold" list. /portfolio answers the same
  // question for ONE chain, because it reports PnL in that chain's native coin
  // and ETH profit cannot be added to BNB profit. USD is what makes this list
  // possible across chains, so it is the only unit here.
  'tok.title': { en: '🪙 <b>Your tokens</b> · every chain', id: '🪙 <b>Token kamu</b> · semua chain' },
  'tok.total': { en: '{usd} in tokens', id: '{usd} dalam bentuk token' },
  'tok.empty': {
    en: 'No tokens yet — only your coins.\n\nPaste a token contract address and tap Buy; whatever you buy shows up here, grouped by the chain it lives on.',
    id: 'Belum ada token — baru coin saja.\n\nPaste alamat kontrak token lalu tap Buy; semua yang kamu beli muncul di sini, dikelompokkan per chain.',
  },
  'tok.no_price': { en: '<i>price unavailable</i>', id: '<i>harga tidak terbaca</i>' },
  'tok.plus_unknown': { en: '<i>+ more we could not price</i>', id: '<i>+ ada yang harganya tidak terbaca</i>' },
  'tok.unpriced_note': {
    en: "<i>A price we can't read is left out of the totals rather than counted as zero — usually a pool with no liquidity right now.</i>",
    id: '<i>Harga yang tidak terbaca tidak dihitung sebagai nol, tapi dikeluarkan dari total — biasanya karena pool-nya lagi tidak ada likuiditas.</i>',
  },
  'tok.note': {
    en: '<i>Tap a token to open its card. This lists what you bought with the bot — a token sent in from another wallet is not tracked.</i>',
    id: '<i>Tap token untuk buka kartunya. Yang terdaftar di sini adalah yang kamu beli lewat bot — token kiriman dari wallet lain tidak ikut tercatat.</i>',
  },

  // ---------------------------------------------------------------- safety
  // Four states, four different sentences. "No line" used to mean both "passed"
  // and "we never managed to check", on the screen where the user taps Buy.
  'sec.clean': { en: '✅ <b>Safety check passed</b> — no red flags', id: '✅ <b>Cek keamanan lolos</b> — tidak ada tanda bahaya' },
  'sec.unchecked': {
    en: "❔ <b>Not checked</b> — the safety service didn't answer. This token has NOT been screened.",
    id: '❔ <b>Belum dicek</b> — layanan keamanannya tidak menjawab. Token ini <b>belum</b> discreening.',
  },
  'sec.unsupported': {
    en: '❔ <b>Not checked</b> — automated screening is unavailable on {chain}.',
    id: '❔ <b>Belum dicek</b> — screening otomatis tidak tersedia di {chain}.',
  },

  // ---------------------------------------------------------------- portfolio
  'pf.unpriced': {
    en: '<i>{n} position(s) left out — we could not read a price for them, and counting them as $0 would show a loss that did not happen.</i>',
    id: '<i>{n} posisi tidak dihitung — harganya tidak terbaca, dan menghitungnya sebagai $0 akan memunculkan rugi yang sebenarnya tidak terjadi.</i>',
  },
  'pf.empty_chain': {
    en: 'Nothing held on this chain.\n\nThis screen covers one chain at a time, because profit in ETH cannot be added to profit in BNB. Tap <b>🪙 My tokens</b> to see everything you hold on every chain at once.',
    id: 'Tidak ada yang dipegang di chain ini.\n\nLayar ini hanya menampilkan satu chain, karena profit dalam ETH tidak bisa dijumlahkan dengan profit dalam BNB. Tap <b>🪙 My tokens</b> untuk melihat semua yang kamu pegang di semua chain sekaligus.',
  },

  // ---------------------------------------------------------------- buy
  'buy.inflight': {
    en: '⏳ Already buying that token — wait for the result before buying again.',
    id: '⏳ Token itu sedang diproses — tunggu hasilnya dulu sebelum beli lagi.',
  },
  'buy.progress': { en: '⏳ <b>Buying {amt} {native}</b>{atMc}…', id: '⏳ <b>Beli {amt} {native}</b>{atMc}…' },
  // {atMc} exists here for the same reason it exists on 'buy.progress': the one
  // question everybody asks is what market cap they got in at. It was on the
  // single-wallet line only, so selecting a second wallet silently deleted it.
  // Both languages carry the slot or i18n.test.js fails on the mismatch — and a
  // template without the slot would discard the value in silence, which is the
  // failure mode that makes a fix look like it did nothing.
  'buy.progress.multi': {
    en: '⏳ <b>Buying {amt} {native} on {n} wallets</b>{atMc}…',
    id: '⏳ <b>Beli {amt} {native} di {n} wallet</b>{atMc}…',
  },
  'buy.at_mc': { en: ' at MC <b>${mc}</b>', id: ' di MC <b>${mc}</b>' },
  // Shown the instant the transaction is broadcast, well before it confirms. On a
  // 12-second chain this is the whole difference between a bot that feels alive
  // and one that looks hung.
  'buy.sent': {
    en: '🚀 <b>Buy sent</b> — {amt} {native}\nWaiting for the network to confirm it…\n{link}',
    id: '🚀 <b>Buy terkirim</b> — {amt} {native}\nMenunggu konfirmasi jaringan…\n{link}',
  },
  'sell.sent': {
    en: '🚀 <b>Sell sent</b> — {pct}%\nWaiting for the network to confirm it…\n{link}',
    id: '🚀 <b>Sell terkirim</b> — {pct}%\nMenunggu konfirmasi jaringan…\n{link}',
  },
  'buy.receipt.title': { en: '✅ <b>Bought ${sym}</b>', id: '✅ <b>Berhasil beli ${sym}</b>' },
  'buy.receipt.spent': { en: 'Spent: <b>{amt} {native}</b> ({usd})', id: 'Terpakai: <b>{amt} {native}</b> ({usd})' },
  'buy.receipt.got': { en: 'Got: <b>{amt} ${sym}</b> ({usd})', id: 'Dapat: <b>{amt} ${sym}</b> ({usd})' },
  // "Entry" is the price the TRADE filled at — spent ÷ received — and it used to
  // be the price on the CARD, which nobody paid. See receipt.js `fillStats`: the
  // Monitor that opens straight after this receipt computes its P/L against the
  // real basis, so a card-price "entry" put the two messages in open
  // contradiction on every buy that cost more than mid.
  'buy.receipt.entry': { en: 'Entry: <b>${px}</b>', id: 'Harga masuk: <b>${px}</b>' },
  // The bot's cut is carved out BEFORE the swap, so a 0.1 SOL buy reaches the
  // pool as 0.099 and every screen showed the 0.099. The missing 1% was real
  // money leaving a wallet with nothing on any card to account for it.
  'buy.receipt.fee': { en: 'Bot fee: <b>{amt} {native}</b> ({pct}%)', id: 'Biaya bot: <b>{amt} {native}</b> ({pct}%)' },
  // The line that turns "the bot instantly lost me 10%" into a cost the user can
  // see and decide about. {down} is NOT {pct} — a fill 10.4% over mid opens at
  // −9.4% — and stating one as the other is the same contradiction one level down.
  'buy.receipt.vs_card': {
    en: '<i>Card price was ${shown} — your fill is {pct}% above it, so the position starts around −{down}% until the price moves.</i>',
    id: '<i>Harga di kartu ${shown} — fill kamu {pct}% di atasnya, jadi posisi mulai sekitar −{down}% sampai harganya bergerak.</i>',
  },
  // Jupiter returns a price impact on every quote and nothing ever read it. When
  // the fill came in above the card, this is the difference between "the pool is
  // thin" and "our price feed disagrees with the router" — two problems with
  // different answers that used to get one shrug.
  'buy.receipt.impact': {
    en: '⚠️ Thin pool — this size moved the price ~<b>{pct}%</b>.',
    id: '⚠️ Pool tipis — ukuran ini menggeser harga ~<b>{pct}%</b>.',
  },
  // Jupiter promised, the wallet received less. The only signal a Token-2022
  // transfer fee ever gives, and it was console.warn'd where no user could see it.
  'buy.receipt.shortfall': {
    en: '⚠️ Delivered <b>{pct}%</b> under the quote — this token may charge a transfer fee.',
    id: '⚠️ Diterima <b>{pct}%</b> di bawah quote — token ini mungkin memungut transfer fee.',
  },
  // The multi-wallet receipt's own entry line. Deliberately worded as "entered
  // at", never just "market cap": the line under it IS a market cap — the
  // current one — and two unlabelled caps on one card is how a user concludes
  // the bot cannot count.
  'buy.receipt.entry_mc': {
    en: '🎯 Entered at market cap <b>${mc}</b>',
    id: '🎯 Masuk di market cap <b>${mc}</b>',
  },
  // The price the trade ACTUALLY filled at — spent ÷ received. Both halves were
  // already on the receipt, one line apart, and nothing divided them, so a buy
  // that filled at 3x the displayed price printed the whole proof and never the
  // conclusion.
  'buy.receipt.realised': {
    en: '🧾 You actually paid <b>${px}</b> per token',
    id: '🧾 Kamu sebenarnya bayar <b>${px}</b> per token',
  },
  'buy.receipt.worse_than_shown': {
    en: '⚠️ <b>{times}× worse</b> than the price on the card — the pool is thinner than it looks, or the token charges a transfer fee.',
    id: '⚠️ <b>{times}× lebih buruk</b> dari harga di kartu — pool-nya lebih tipis dari kelihatannya, atau tokennya memungut transfer fee.',
  },
  'buy.receipt.wallet': { en: 'Wallet: {wallet} · {venue}', id: 'Wallet: {wallet} · {venue}' },
  // Three outcomes, three headers. ✅ is a claim about what happened, so it may
  // not be the header for a trade where nothing happened: a card once read
  // "✅ Bought $ · 0/5 wallets · spent 0.00000 ETH" over five red errors, on a
  // Solana buy. Green tick, no token, wrong coin, and a total of zero presented
  // as a total.
  'buy.receipt.multi': {
    en: '✅ <b>Bought ${sym}</b> · {ok}/{n} wallets\nTotal: <b>{tokens} ${sym}</b> · spent <b>{spent} {native}</b>{usd}',
    id: '✅ <b>Berhasil beli ${sym}</b> · {ok}/{n} wallet\nTotal: <b>{tokens} ${sym}</b> · terpakai <b>{spent} {native}</b>{usd}',
  },
  'buy.receipt.multi.some': {
    en: '⚠️ <b>Bought ${sym}</b> · only {ok} of {n} wallets\nTotal: <b>{tokens} ${sym}</b> · spent <b>{spent} {native}</b>{usd}',
    id: '⚠️ <b>Berhasil beli ${sym}</b> · cuma {ok} dari {n} wallet\nTotal: <b>{tokens} ${sym}</b> · terpakai <b>{spent} {native}</b>{usd}',
  },
  'buy.receipt.multi.none': {
    en: "❌ <b>Nothing bought</b> · 0 of {n} wallets\n<i>No {native} was spent.</i>",
    id: '❌ <b>Tidak ada yang kebeli</b> · 0 dari {n} wallet\n<i>Tidak ada {native} yang terpakai.</i>',
  },
  // Five wallets failing the same way is one fact. Naming them keeps the roll-up
  // from reading as "and the others are still going".
  'buy.receipt.multi.same': {
    en: 'Same on every wallet: {wallets}.',
    id: 'Sama di semua wallet: {wallets}.',
  },
  'buy.failed': { en: "❌ <b>Buy didn't go through</b>", id: '❌ <b>Buy tidak berhasil</b>' },

  // ---------------------------------------------------------------- sell
  'sell.progress': { en: '⏳ <b>Selling {pct}% of {what}…</b>', id: '⏳ <b>Jual {pct}% dari {what}…</b>' },
  'sell.progress.multi': {
    en: '⏳ <b>Selling {pct}% on {n} wallets…</b>',
    id: '⏳ <b>Jual {pct}% di {n} wallet…</b>',
  },
  'sell.your_token': { en: 'your token', id: 'token kamu' },
  'sell.retry': {
    en: '⚙️ <b>Retry {n}/2</b> — raising gas &amp; slippage to complete the sell…',
    id: '⚙️ <b>Percobaan {n}/2</b> — menaikkan gas &amp; slippage supaya sell-nya tembus…',
  },
  'sell.receipt.title': { en: '✅ <b>Sold {pct}% of ${sym}</b>', id: '✅ <b>Berhasil jual {pct}% dari ${sym}</b>' },
  'sell.receipt.received': { en: 'Received: <b>{amt} {native}</b>{usd}', id: 'Diterima: <b>{amt} {native}</b>{usd}' },
  'sell.receipt.pnl': { en: 'P/L: <b>{pnl}</b>{usd}', id: 'Untung/Rugi: <b>{pnl}</b>{usd}' },
  'sell.receipt.multi': {
    en: '✅ <b>Sold {pct}%</b> · {ok}/{n} wallets{skip}\nTotal received: <b>{amt} {native}</b>{usd}',
    id: '✅ <b>Berhasil jual {pct}%</b> · {ok}/{n} wallet{skip}\nTotal diterima: <b>{amt} {native}</b>{usd}',
  },
  'sell.receipt.multi.skip': { en: ' ({n} had no bag)', id: ' ({n} tidak punya posisi)' },
  'sell.no_bag': { en: '— no bag', id: '— tidak ada posisi' },
  'sell.failed': { en: "❌ <b>Sell didn't go through</b>", id: '❌ <b>Sell tidak berhasil</b>' },

  // ------------------------------------------------- one wallet, one receipt
  // A multi-wallet trade posts one of these PER WALLET, the moment that wallet
  // settles, instead of a single message built after the slowest one finished.
  // See receipt.js for why.
  //
  // 🟢 means SUCCEEDED, on a buy and on a sell alike — it answers "did it go
  // through", not "which direction". A red dot on a completed exit would read
  // as a failure.
  'wallet.receipt.buy.ok': {
    en: '🟢 <b>Buy</b> of {qty} {sym}{sup} succeeded · 💳 <b>{wallet}</b>',
    id: '🟢 <b>Beli</b> {qty} {sym}{sup} berhasil · 💳 <b>{wallet}</b>',
  },
  'wallet.receipt.sell.ok': {
    en: '🟢 <b>Sell</b> of {qty} {sym}{sup} succeeded · 💳 <b>{wallet}</b>',
    id: '🟢 <b>Jual</b> {qty} {sym}{sup} berhasil · 💳 <b>{wallet}</b>',
  },
  // The share of total supply this fill is ("harus ada berapa % dari
  // supply"). Rendered ONLY when the supply could actually be read — an
  // unknown supply printed as 0% would be a stated fact that is false.
  'wallet.receipt.supply': {
    en: ' (<b>{pct}</b> of supply)',
    id: ' (<b>{pct}</b> dari supply)',
  },
  'wallet.receipt.buy.fail': { en: '❌ <b>Buy failed</b> · 💳 <b>{wallet}</b>', id: '❌ <b>Buy gagal</b> · 💳 <b>{wallet}</b>' },
  'wallet.receipt.sell.fail': { en: '❌ <b>Sell failed</b> · 💳 <b>{wallet}</b>', id: '❌ <b>Sell gagal</b> · 💳 <b>{wallet}</b>' },
  // Deliberately not ❌. A wallet holding nothing did exactly the right thing
  // when asked to sell, and a red cross sends people hunting for a fault.
  'wallet.receipt.nobag': { en: '⚪️ <b>Nothing to sell</b> · 💳 <b>{wallet}</b>', id: '⚪️ <b>Tidak ada posisi</b> · 💳 <b>{wallet}</b>' },
  'wallet.receipt.spent': { en: '💸 Spent <b>{amt} {native}</b>{usd}', id: '💸 Keluar <b>{amt} {native}</b>{usd}' },
  // "Received", not "You gained" — a sell at a loss still has proceeds, and
  // "you gained" above a −78% exit tells the user the opposite of what
  // happened. Gain and loss belong on the P/L line and nowhere else.
  'wallet.receipt.received': { en: '💰 Received <b>{amt} {native}</b>{usd}', id: '💰 Diterima <b>{amt} {native}</b>{usd}' },
  'wallet.receipt.pnl': { en: '{icon} P/L <b>{pnl}</b>{usd}{pct}', id: '{icon} Untung/Rugi <b>{pnl}</b>{usd}{pct}' },
  // Three shapes per side, because the fill price and the market cap are known
  // independently: the price is derived from the trade itself and is almost
  // always available, the cap comes from an indexer that may not have answered.
  // Printing "$0" for either is a claim about the token that nobody made.
  'wallet.receipt.entry_full': { en: '🌊 Entry <b>${px}</b> · MC <b>${mc}</b>', id: '🌊 Masuk <b>${px}</b> · MC <b>${mc}</b>' },
  'wallet.receipt.exit_full': { en: '🌊 Exit <b>${px}</b> · MC <b>${mc}</b>', id: '🌊 Keluar <b>${px}</b> · MC <b>${mc}</b>' },
  'wallet.receipt.entry_mc': { en: '🌊 Entry MC · <b>${mc}</b>', id: '🌊 MC masuk · <b>${mc}</b>' },
  'wallet.receipt.exit_mc': { en: '🌊 Exit MC · <b>${mc}</b>', id: '🌊 MC keluar · <b>${mc}</b>' },
  'wallet.receipt.entry_px': { en: '🌊 Entry <b>${px}</b>', id: '🌊 Masuk <b>${px}</b>' },
  'wallet.receipt.exit_px': { en: '🌊 Exit <b>${px}</b>', id: '🌊 Keluar <b>${px}</b>' },
  'wallet.receipt.tx': { en: '🔍 Transaction', id: '🔍 Transaksi' },

  // ------------------------------------------------------------ snipe by CA
  // "Buy THIS contract the moment it can be bought." The launch snipe buys
  // every new token on a chain and the dev snipe buys whatever a followed
  // wallet launches; neither can express having the address in advance.
  // The sniper HOME — where 🎯 Snipe and /snipe land. Targeted (the panel) is
  // the front door; mass mode and dev snipe are labelled choices below.
  'snipe.ca.title': { en: '🎯 <b>Sniper</b>', id: '🎯 <b>Sniper</b> — snipe token incaranmu' },
  'snipe.ca.blurb': {
    en: 'Arm an address before its pool opens. The bot checks it every few seconds and buys the instant a swap can actually be filled — on any enabled chain, Solana included.',
    id: 'Pasang alamat sebelum pool-nya dibuka. Bot cek tiap beberapa detik dan langsung beli begitu swap benar-benar bisa jalan — di semua chain yang aktif, termasuk Solana.',
  },
  'snipe.ca.armed_head': { en: '<b>Armed ({n})</b>', id: '<b>Terpasang ({n})</b>' },
  'snipe.ca.none': { en: '<i>Nothing armed yet.</i>', id: '<i>Belum ada yang dipasang.</i>' },
  'snipe.ca.recent_head': { en: '<b>Recent</b>', id: '<b>Terakhir</b>' },
  'snipe.ca.how': {
    en: '<i>Send: contract, amount, and optionally a slippage %. A launch fills through a one-block-old pool, so a wider bound than your normal one is usually what gets you in.</i>',
    id: '<i>Kirim: kontrak, jumlah, dan opsional slippage %. Launch itu isi lewat pool yang baru satu blok, jadi biasanya butuh slippage lebih lebar dari biasanya.</i>',
  },
  // The panel (snipe.panel.open_btn) sits above this on the same screen, so
  // this label says what makes the second way in DIFFERENT: you type one line.
  'snipe.ca.add_btn': { en: '⌨️ One-line arm — type it', id: '⌨️ Arm satu baris — langsung ketik' },
  // Mass mode is the old chain-wide auto-snipe. Its button carries the LIVE
  // armed state ({what} = "Solana · 0.1 SOL" or "2 chains") — what the bot is
  // doing with real money belongs on the button itself.
  'snipe.ca.launch_btn': { en: '🌊 Mass mode — buy every new launch', id: '🌊 Mode massal — beli semua launch baru' },
  'snipe.ca.mass_armed': { en: '🌊 Mass mode · 🟢 ON — {what}', id: '🌊 Mode massal · 🟢 AKTIF — {what}' },
  'snipe.ca.mass_note': {
    en: '⚠️ <b>Mass mode is ON</b> — buying every new launch on {list}, <b>{amt}</b> each. Tap 🌊 below to stop or change it.',
    id: '⚠️ <b>Mode massal AKTIF</b> — beli semua launch baru di {list}, <b>{amt}</b> per launch. Tap 🌊 di bawah untuk stop atau ubah.',
  },
  'snipe.ca.dev_btn': { en: '🧑‍💻 Dev snipe — follow a developer', id: '🧑‍💻 Dev snipe — ikuti developer' },
  // Chain FIRST — the Sol-Trading-Bot panel this mirrors starts at "Exchange".
  // Binding the target to whatever chain happened to be active meant a Solana
  // mint pasted while Ethereum was active bounced as "not a valid contract
  // address", with the fix two screens away.
  'snipe.ca.pick_chain': {
    en: '📍 <b>Snipe a contract</b>\n\nWhich chain does the launch happen on?',
    id: '📍 <b>Snipe satu kontrak</b>\n\nLaunch-nya di chain mana?',
  },
  // {ex} is a chain-shaped example address — a Solana user shown `0xabc…`
  // copies the shape they were shown.
  'snipe.ca.prompt': {
    en: '📍 <b>Snipe a contract</b> on {chain}\n\nOne line sets the whole snipe — like a config panel, without the taps:\n<b>&lt;contract&gt; &lt;amount&gt; [slip%] [tp%/sl%] [expiry h]</b>\n\n<code>{ex} 0.05</code> → buy 0.05 {native}, your normal slippage\n<code>{ex} 0.05 25</code> → …at 25% slippage\n<code>{ex} 0.05 25 100/50</code> → …then take profit at <b>+100%</b>, stop loss at <b>−50%</b>, placed automatically the moment the snipe fills\n<code>{ex} 0.05 25 100/50 12</code> → …and give up after <b>12h</b> if it never launches\n\n<i>Nothing is spent until the pool opens.</i>',
    id: '📍 <b>Snipe satu kontrak</b> di {chain}\n\nSatu baris untuk seluruh setelan snipe — seperti panel config, tanpa banyak tap:\n<b>&lt;kontrak&gt; &lt;jumlah&gt; [slip%] [tp%/sl%] [expiry jam]</b>\n\n<code>{ex} 0.05</code> → beli 0.05 {native}, slippage biasa\n<code>{ex} 0.05 25</code> → …slippage 25%\n<code>{ex} 0.05 25 100/50</code> → …lalu take profit di <b>+100%</b>, stop loss di <b>−50%</b>, terpasang otomatis begitu snipe-nya kebeli\n<code>{ex} 0.05 25 100/50 12</code> → …dan hangus setelah <b>12 jam</b> kalau tidak pernah launch\n\n<i>Tidak ada dana keluar sampai pool-nya buka.</i>',
  },
  'snipe.ca.armed': {
    en: '✅ <b>Armed</b> · {chain}\n<code>{ca}</code>\n\nBuys <b>{amt} {native}</b> at <b>{slip}</b> slippage the moment it becomes tradeable.{exits}\nExpires in <b>{hours}h</b> if it never launches.',
    id: '✅ <b>Terpasang</b> · {chain}\n<code>{ca}</code>\n\nBeli <b>{amt} {native}</b> dengan slippage <b>{slip}</b> begitu bisa ditradingkan.{exits}\nHangus dalam <b>{hours} jam</b> kalau tidak pernah launch.',
  },
  'snipe.ca.slip_default': { en: 'your normal', id: 'slippage biasa' },
  'snipe.ca.bad_addr': { en: "❌ That is not a valid <b>{chain}</b> contract address. Send it again, or tap ➕ and pick a different chain.", id: '❌ Itu bukan alamat kontrak <b>{chain}</b> yang valid. Kirim ulang, atau tap ➕ dan pilih chain lain.' },
  'snipe.ca.bad_amount': { en: '❌ Send an amount in <b>{native}</b> after the address, e.g. <code>0.05</code>.', id: '❌ Kirim jumlah dalam <b>{native}</b> setelah alamat, misalnya <code>0.05</code>.' },
  'snipe.ca.bad_slip': { en: '❌ Slippage must be between <b>0</b> and <b>50</b> percent.', id: '❌ Slippage harus antara <b>0</b> dan <b>50</b> persen.' },
  'snipe.ca.bad_tpsl': { en: '❌ TP/SL must look like <code>100/50</code> (take profit % / stop loss %), stop loss below 100.', id: '❌ TP/SL harus seperti <code>100/50</code> (take profit % / stop loss %), stop loss di bawah 100.' },
  'snipe.ca.bad_ttl': { en: '❌ Expiry must be 1–168 hours.', id: '❌ Expiry harus 1–168 jam.' },
  'snipe.ca.exits': { en: '\nThen: <b>{parts}</b> — placed automatically at the fill price.', id: '\nLalu: <b>{parts}</b> — terpasang otomatis di harga fill.' },

  // ------------------------------------------------------- snipe setup panel
  // The Sol-Trading-Bot-style panel over the SAME target store as the one-line
  // arm. Every row is a button, every value is picked — and only settings the
  // engine actually honours get a row: a row the backend ignores would be the
  // stop-loss-the-user-believes-exists, as a whole screen.
  'snipe.panel.title': { en: '🎛 <b>Snipe Setup</b> — {chain}', id: '🎛 <b>Setup Snipe</b> — {chain}' },
  'snipe.panel.blurb': {
    en: 'Every setting on one panel. Tap a row, pick a value — ⚡ arms it.',
    id: 'Semua setelan di satu panel. Tap barisnya, pilih nilainya — ⚡ untuk pasang.',
  },
  'snipe.panel.required': { en: '<b>— REQUIRED —</b>', id: '<b>— WAJIB —</b>' },
  'snipe.panel.optional': { en: '<b>— OPTIONAL —</b>', id: '<b>— OPSIONAL —</b>' },
  // Row labels. Trading jargon stays in English per the convention at the top
  // of this file — "Chain", "Wallet", "Slippage" are the words these users use.
  'snipe.panel.chain': { en: 'Chain', id: 'Chain' },
  // Just "Target" — a label reading "Target contract" told dev-wallet snipers
  // this feature was not for them ("dmn target dev walletnya").
  'snipe.panel.target': { en: 'Target', id: 'Target' },
  'snipe.panel.wallet': { en: 'Wallet', id: 'Wallet' },
  'snipe.panel.amount': { en: 'Amount', id: 'Jumlah' },
  'snipe.panel.amount_dev': { en: 'Amount / launch', id: 'Jumlah / launch' },
  'snipe.panel.slip': { en: 'Slippage', id: 'Slippage' },
  'snipe.panel.tpsl': { en: 'TP / SL', id: 'TP / SL' },
  'snipe.panel.ttl': { en: 'Expiry', id: 'Masa aktif' },
  'snipe.panel.waiting': { en: 'waiting for the contract — tap to set it', id: 'menunggu kontrak — tap untuk isi' },
  'snipe.panel.pick': { en: 'pick how much to spend', id: 'pilih jumlah belanjanya' },
  'snipe.panel.off': { en: 'off', id: 'nonaktif' },
  'snipe.panel.foot': {
    en: '<i>Nothing is spent until the pool opens. TP/SL become real sell orders at the fill price, on the wallet that sniped.</i>',
    id: '<i>Tidak ada dana keluar sampai pool-nya buka. TP/SL jadi order jual sungguhan di harga fill, di wallet yang dipakai snipe.</i>',
  },
  'snipe.panel.open_btn': { en: '🎛 New snipe — full settings', id: '🎛 Snipe baru — setelan lengkap' },
  // The arm button and what replaces the panel once its draft is spent. The
  // confirmation itself is a NEW message (see the 'arm' handler): an in-place
  // edit of the panel is invisible the moment the user has scrolled, which is
  // how arming a snipe read as "nothing happened".
  'snipe.panel.arm_btn': { en: '⚡ ARM SNIPE — start watching', id: '⚡ PASANG SNIPE — mulai pantau' },
  'snipe.panel.spent': {
    en: '🎛 <b>Snipe Setup</b> — armed ✅\n<i>The confirmation is below.</i>',
    id: '🎛 <b>Setup Snipe</b> — terpasang ✅\n<i>Konfirmasinya ada di bawah.</i>',
  },
  'snipe.panel.home_btn': { en: '🎯 Sniper', id: '🎯 Sniper' },
  'snipe.panel.ready': {
    en: '✅ <b>Ready.</b> Nothing is armed yet — tap <b>⚡ ARM SNIPE</b> below to start watching.',
    id: '✅ <b>Siap.</b> Belum terpasang — tap <b>⚡ PASANG SNIPE</b> di bawah untuk mulai memantau.',
  },
  'snipe.panel.not_ready': {
    en: '⏳ Fill the rows marked ⏳ above, then tap <b>⚡ ARM SNIPE</b>.',
    id: '⏳ Isi dulu baris bertanda ⏳ di atas, lalu tap <b>⚡ PASANG SNIPE</b>.',
  },
  // Replaces the ready line whenever the panel carries a refusal: the reason is
  // already printed above, and repeating "tap ⚡ ARM SNIPE" underneath it is the
  // panel telling the reader to do the thing that just failed.
  // The panel's own reading of the duplicate the arming sites refuse. Said HERE,
  // where the Target row that fixes it is one tap away, instead of after a tap
  // that could never have worked.
  'snipe.panel.already_dev': {
    en: '✅ <b>Already watching this developer</b> — spent <b>{spent} {native}</b> so far. Tapping ⚡ now <b>UPDATES</b> it to the settings above; what it has already spent stays spent.',
    id: '✅ <b>Developer ini sudah dipantau</b> — sudah terpakai <b>{spent} {native}</b>. Tap ⚡ sekarang akan <b>MEMPERBARUI</b> ke pengaturan di atas; yang sudah terpakai tetap terhitung.',
  },
  'snipe.panel.already_ca': {
    en: '✅ <b>This contract is already armed</b> on this chain. Tapping ⚡ now <b>UPDATES</b> it to the settings above rather than arming a second one.',
    id: '✅ <b>Kontrak ini sudah terpasang</b> di chain ini. Tap ⚡ sekarang akan <b>MEMPERBARUI</b> ke pengaturan di atas, bukan memasang yang kedua.',
  },
  'snipe.panel.update_btn': { en: '⚡ UPDATE — apply these settings', id: '⚡ PERBARUI — terapkan pengaturan ini' },
  // THE DEV SNIPE HAS NO CAP. The budget feature was removed outright, so the
  // panel states the consequence in its place — an uncapped auto-buyer that
  // does not say it is uncapped is the one shape this repo will not ship.
  'snipe.panel.nocap': {
    en: 'No spending cap: this buys <b>{per} {native}</b> of EVERY launch this developer makes, until you turn it off or remove it. Your wallet balance is the only limit.',
    id: 'Tanpa batas belanja: ini membeli <b>{per} {native}</b> pada SETIAP launch developer ini, sampai Anda matikan atau hapus. Saldo wallet adalah satu-satunya batas.',
  },
  'snipe.panel.updated': {
    en: '✅ <b>Updated</b> — the watch now uses the settings you just set.\nSpent so far: <b>{spent} {native}</b> (an edit never un-spends money).',
    id: '✅ <b>Diperbarui</b> — pantauan sekarang memakai pengaturan yang baru Anda set.\nSudah terpakai: <b>{spent} {native}</b> (mengubah pengaturan tidak mengembalikan dana yang sudah terpakai).',
  },
  'copy.spent_uncapped': { en: 'spent {spent} · <b>no cap</b>', id: 'terpakai {spent} · <b>tanpa batas</b>' },
  'snipe.panel.see_dev_btn': { en: '👥 Already watching — open Copy & Snipe', id: '👥 Sudah dipantau — buka Copy & Snipe' },
  'snipe.panel.see_ca_btn': { en: '🎯 Already armed — open Sniper', id: '🎯 Sudah terpasang — buka Sniper' },
  'snipe.panel.refused': {
    en: '⚠️ <b>Not armed.</b> The reason is above — fix that row, or open 👥 Copy &amp; Snipe to see what is already watching.',
    id: '⚠️ <b>Belum terpasang.</b> Alasannya di atas — perbaiki baris itu, atau buka 👥 Copy &amp; Snipe untuk melihat yang sudah memantau.',
  },
  'snipe.panel.refused_msg': {
    en: '⚠️ <b>Not armed</b> — {why}.\nNothing is watching and nothing was spent. The setup panel above still holds your settings.',
    id: '⚠️ <b>Belum terpasang</b> — {why}.\nTidak ada yang memantau dan tidak ada dana terpakai. Panel setup di atas masih menyimpan pengaturan Anda.',
  },
  'snipe.panel.oneline_btn': { en: '⌨️ One line', id: '⌨️ Satu baris' },
  'snipe.panel.discard_btn': { en: '🗑 Discard', id: '🗑 Buang' },
  'snipe.panel.set_btn': { en: 'Set target', id: 'Isi target' },
  'snipe.panel.pick_btn': { en: 'Pick amount', id: 'Pilih jumlah' },
  'snipe.panel.custom_btn': { en: '✏️ Custom', id: '✏️ Isi sendiri' },
  // Sub-screens, one per row.
  // The picker is a MULTI-SELECT, the same model as the buy/sell wallet picker
  // ("bisa pilih multi wallet, all on atau all off, sama kaya beli"): tap to
  // toggle, ✅/⬜ set the lot, ✔ Done returns to the panel.
  'snipe.panel.wal_pick': {
    en: '💳 <b>Wallets</b>\n\nTap wallets to turn them on or off — the snipe buys on <b>every selected wallet at once</b>, and the amount is <b>per wallet</b>.',
    id: '💳 <b>Wallet</b>\n\nTap wallet untuk nyalakan atau matikan — snipe beli di <b>semua wallet yang dipilih sekaligus</b>, dan jumlahnya <b>per wallet</b>.',
  },
  'snipe.panel.wallet_all': { en: '👥 All ({n})', id: '👥 Semua ({n})' },
  'snipe.panel.wallet_n': { en: '👥 {k}/{n} wallets', id: '👥 {k}/{n} wallet' },
  'snipe.panel.wallet_all_btn': { en: '✅ All on ({n})', id: '✅ Semua on ({n})' },
  'snipe.panel.wallet_none_btn': { en: '⬜ All off', id: '⬜ Semua off' },
  'snipe.panel.done_btn': { en: '✔ Done', id: '✔ Selesai' },
  // Appended to the armed confirmation when the target fires on every wallet:
  // the multiplied total is real money and belongs on the consent message.
  // The scope, and the two CADENCES. The cadence belongs to the FEATURE, not to
  // the wallet selection: a CA snipe fires ONCE (its total is a one-off), a dev
  // snipe fires on EVERY launch, with no cap at all. Keying these on
  // '*'-vs-subset instead put the one-shot sentence on a recurring watch — the
  // most expensive half of the pair to understate.
  'snipe.panel.scope_all': { en: 'every wallet ({n})', id: 'semua wallet ({n})' },
  'snipe.panel.scope_n': { en: '{n} wallets', id: '{n} wallet' },
  'snipe.panel.armed_wallets': {
    en: '👥 On <b>{scope}</b> — {amt} {native} each, up to <b>{total} {native}</b> in total if every wallet fills.',
    id: '👥 Di <b>{scope}</b> — {amt} {native} per wallet, total sampai <b>{total} {native}</b> kalau semuanya keisi.',
  },
  'dev.armed_wallets': {
    en: '👥 On <b>{scope}</b> — {amt} {native} each, so <b>{total} {native}</b> on EVERY launch, with no cap.',
    id: '👥 Di <b>{scope}</b> — {amt} {native} per wallet, jadi <b>{total} {native}</b> tiap launch, tanpa batas.',
  },
  // ONE question, nothing else ("untuk ini cukup berikan pertanyaan dev wallet
  // aja"). The what-happens-next explanation lives on the panel's dev footer,
  // and the amount/budget questions follow on their own screens — restating
  // them here was the old rulebook prompt creeping back. The one-line shortcut
  // still WORKS for whoever knows it; advertising it here is what read as a
  // rule to follow.
  'snipe.panel.dev_prompt': {
    en: "🧑‍💻 <b>Dev wallet</b> on {chain}\n\nPaste the <b>developer's wallet address</b>:",
    id: '🧑‍💻 <b>Wallet developer</b> di {chain}\n\nPaste <b>alamat wallet developer</b>-nya:',
  },
  'snipe.panel.dev_foot': {
    en: "<i>Buys use the wallet and slippage on this panel; TP/SL become real sell orders at each fill. Only this developer's own launches are bought — never its ordinary trades. Honeypots are skipped. There is no spending cap: TP/SL and your wallet balance are what bound the risk.</i>",
    id: '<i>Buy pakai wallet dan slippage di panel ini; TP/SL jadi order jual sungguhan di tiap fill. Hanya launch milik developer ini yang dibeli — bukan trade biasanya. Honeypot otomatis dilewati. Tidak ada batas belanja: TP/SL dan saldo wallet Anda yang membatasi risikonya.</i>',
  },
  'snipe.panel.amt_pick': {
    en: '💵 <b>Amount</b>\n\nHow much {native} should this snipe spend when it fires?\n\n<i>Keep it small — a launch is high-risk by definition.</i>',
    id: '💵 <b>Jumlah</b>\n\nBerapa {native} yang dipakai waktu snipe ini kebeli?\n\n<i>Jangan kegedean — namanya juga launch, risikonya tinggi.</i>',
  },
  'snipe.panel.slip_pick': {
    en: '📉 <b>Slippage</b>\n\nA launch fills through a one-block-old pool — a wider bound than your normal one is usually what gets you in.',
    id: '📉 <b>Slippage</b>\n\nLaunch keisi lewat pool yang umurnya baru satu blok — biasanya butuh slippage lebih lebar dari biasanya supaya tembus.',
  },
  'snipe.panel.tpsl_pick': {
    en: '📊 <b>TP / SL</b>\n\nPlaced automatically the moment the snipe fills, at the realised entry — not the card price.',
    id: '📊 <b>TP / SL</b>\n\nTerpasang otomatis begitu snipe-nya kebeli, di harga masuk yang sebenarnya — bukan harga di kartu.',
  },
  'snipe.panel.ttl_pick': {
    en: '🕒 <b>Expiry</b>\n\nIf the token never becomes tradeable, the snipe disarms itself after this long.',
    id: '🕒 <b>Masa aktif</b>\n\nKalau token-nya tidak pernah bisa dibeli, snipe ini lepas sendiri setelah selang waktu ini.',
  },
  'snipe.panel.ca_prompt': {
    en: '🎯 <b>Target contract</b> on {chain}\n\nPaste the contract address to snipe, e.g. <code>{ex}</code>\n\n<i>Power move: paste a full line — <b>&lt;contract&gt; &lt;amount&gt; [slip%] [tp/sl] [expiry h]</b> — and every panel row fills at once.</i>',
    id: '🎯 <b>Kontrak target</b> di {chain}\n\nPaste alamat kontrak yang mau di-snipe, contoh <code>{ex}</code>\n\n<i>Jalur cepat: paste satu baris penuh — <b>&lt;kontrak&gt; &lt;jumlah&gt; [slip%] [tp/sl] [expiry jam]</b> — semua baris panel langsung terisi.</i>',
  },
  'snipe.panel.amt_prompt': {
    en: '💵 Send the amount to spend, in {native} (e.g. <code>0.1</code>) or USD (<code>$10</code>).',
    id: '💵 Kirim jumlah yang mau dipakai, dalam {native} (contoh <code>0.1</code>) atau USD (<code>$10</code>).',
  },
  'snipe.panel.slip_prompt': {
    en: '📉 Send a slippage percent, 0–50. <code>0</code> = your normal setting.',
    id: '📉 Kirim persen slippage, 0–50. <code>0</code> = ikut setelan biasa kamu.',
  },
  'snipe.panel.tpsl_prompt': {
    en: '📊 Send <b>tp/sl</b> in percent, e.g. <code>100/50</code> → take profit at +100%, stop loss at −50%. <code>off</code> disables both.',
    id: '📊 Kirim <b>tp/sl</b> dalam persen, contoh <code>100/50</code> → take profit di +100%, stop loss di −50%. <code>off</code> untuk matikan dua-duanya.',
  },
  'snipe.panel.ttl_prompt': {
    en: '🕒 Send how many hours to keep it armed, 1–168.',
    id: '🕒 Kirim mau berapa jam tetap terpasang, 1–168.',
  },
  'snipe.panel.which_chain': {
    en: '🌐 That address fits more than one enabled chain — tap <b>Chain</b> on the panel first, then paste it again.',
    id: '🌐 Alamat itu cocok di lebih dari satu chain yang aktif — tap <b>Chain</b> di panel dulu, lalu paste lagi.',
  },
  'snipe.panel.switched': {
    en: 'Chain switched to {chain} to match the address you pasted.',
    id: 'Chain dipindah ke {chain} menyesuaikan alamat yang kamu paste.',
  },
  'snipe.panel.ca_dropped': {
    en: 'The saved target address does not exist on the chain you just picked, so it was cleared — set it again.',
    id: 'Alamat target yang tersimpan tidak berlaku di chain yang barusan dipilih, jadi dihapus — isi lagi ya.',
  },
  'snipe.panel.target_saved': { en: '✅ Target saved.', id: '✅ Target tersimpan.' },
  // The Target step's two kinds. A dev wallet and a token CA share the same
  // address shape, so the user says which they mean — no paste can be
  // auto-classified into one or the other.
  'snipe.panel.target_kind': {
    en: '🎯 <b>Target</b>\n\nWhat should the snipe watch?\n\n📍 <b>Token contract</b> — buy THIS token the moment its pool opens, once.\n🧑‍💻 <b>Dev wallet</b> — buy every NEW token that developer launches, with no spending cap, until you turn it off.',
    id: '🎯 <b>Target</b>\n\nSnipe-nya mau mengawasi apa?\n\n📍 <b>Kontrak token</b> — beli token INI begitu pool-nya buka, sekali.\n🧑‍💻 <b>Wallet developer</b> — beli tiap token BARU yang di-launch developer itu, tanpa batas belanja, sampai Anda matikan.',
  },
  'snipe.panel.kind_ca': { en: '📍 Token contract', id: '📍 Kontrak token' },
  'snipe.panel.kind_dev': { en: '🧑‍💻 Dev wallet', id: '🧑‍💻 Wallet developer' },

  // ------------------------------------------------------- dev-snipe messages
  // The dev target lives ON the panel (kind 'dev'); these are its own error
  // and confirmation strings.
  'dev.bad_addr': { en: '❌ That is not a valid {chain} wallet address — paste it again.', id: '❌ Itu bukan alamat wallet {chain} yang valid — paste ulang ya.' },
  'dev.bad_amt': { en: '❌ Send a positive amount in {native}, e.g. <code>0.05</code>.', id: '❌ Kirim jumlah positif dalam {native}, contoh <code>0.05</code>.' },
  // ⚠️ The spend has NO CEILING on this feature, so the confirmation says the
  // whole truth: what it buys, on every launch, and what the only stop is. A
  // message that spends money names its trigger — and an uncapped one names its
  // limit, or the absence of it.
  'dev.armed': {
    en: '✅ <b>Dev snipe armed</b> 🧑‍💻\nWatching <code>{addr}</code> on {chain} — every new token it launches, I buy <b>{perBuy} {native}</b>.\n⚠️ <b>No spending cap</b> — this keeps buying until you turn it off, remove it, or the wallet runs out.',
    id: '✅ <b>Dev snipe terpasang</b> 🧑‍💻\nMengawasi <code>{addr}</code> di {chain} — tiap token baru yang dia launch, saya beli <b>{perBuy} {native}</b>.\n⚠️ <b>Tanpa batas belanja</b> — terus membeli sampai Anda matikan, hapus, atau saldo wallet habis.',
  },
  'dev.live': { en: 'The master switch is ON — it is live now.', id: 'Master switch sudah ON — langsung aktif sekarang.' },
  // An OFF master switch after arming is the stop-loss-the-user-believes-
  // exists: the watch does nothing until it is on, so it is said out loud,
  // with the one-tap fix on the same message.
  'dev.master_off': { en: '⚠️ The copy/dev master switch is OFF — tap below to go live.', id: '⚠️ Master switch copy/dev masih OFF — tap di bawah biar langsung aktif.' },
  'dev.on_btn': { en: '🟢 Turn ON now', id: '🟢 Aktifkan sekarang' },

  // ---------------------------------------------------------------- PnL
  // "how did I do on this token" — the one question /portfolio cannot answer,
  // because a bag that has been SOLD leaves that screen entirely.
  'pnl.ask': {
    en: '📊 <b>PnL for a token</b>\n\nPaste the <b>contract address</b> — I will show what you put in, what came back, and what is still open. Sold or still held.',
    id: '📊 <b>PnL satu token</b>\n\nPaste <b>alamat kontraknya</b> — saya tampilkan modal masuk, hasil keluar, dan yang masih terbuka. Sudah dijual atau masih dipegang.',
  },
  'pnl.bad_ca': {
    en: "❌ That doesn't look like a contract address. Paste the token's contract, e.g. from the buy card.",
    id: '❌ Itu sepertinya bukan alamat kontrak. Paste kontrak tokennya, misalnya dari kartu buy.',
  },

  // ---------------------------------------------------------------- errors
  // One clear sentence per failure class, each ending in what to actually do.
  // The raw on-chain / RPC text is still logged server-side for the operator.
  'err.no_bag': {
    en: "You don't hold any of this token to sell.",
    id: 'Kamu tidak punya token ini untuk dijual.',
  },
  'err.insufficient': {
    en: 'Not enough balance to cover this {act} plus network gas. Top up and try again.',
    id: 'Saldo kamu tidak cukup untuk {act} ini plus gas jaringan. Isi saldo dulu, lalu coba lagi.',
  },
  'err.gas_moved': {
    en: 'The network gas price just moved. Please tap {btn} again — it usually goes through on the next try.',
    id: 'Harga gas jaringan barusan berubah. Tap {btn} sekali lagi — biasanya langsung tembus di percobaan berikutnya.',
  },
  'err.slippage': {
    en: "The price moved faster than your slippage allows, so the {act} didn't go through. Try again, or raise your slippage in ⚙️ Settings.",
    id: 'Harga bergerak lebih cepat dari batas slippage kamu, jadi {act}-nya tidak tembus. Coba lagi, atau naikkan slippage di ⚙️ Settings.',
  },
  'err.unconfirmed': {
    en: 'The network is slow right now — your {act} may still complete. Check your wallet before trying again.',
    id: 'Jaringan sedang lambat — {act} kamu mungkin masih akan tembus. Cek wallet dulu sebelum coba lagi.',
  },
  'err.no_price': {
    en: "Couldn't read live pricing for this token right now. Please try again in a moment.",
    id: 'Harga live token ini belum bisa dibaca sekarang. Coba lagi sebentar lagi.',
  },
  // ⚠️ OUR OWN REQUEST BUDGET, NOT A FACT ABOUT THE TOKEN — and for months it
  // wore the sentence above. Five wallets buying one token fire five quotes,
  // five swap-builds and five token reads in the same millisecond at a Jupiter
  // tier metered per IP; the overflow comes back 429, and "Couldn't read live
  // pricing for this token" sent the user to look at their token while the
  // answer was the number of wallets they had selected. It says what to do
  // (fewer wallets, or a key) because a diagnosis with no hands attached is a
  // bug report the code files against its owner.
  'err.rate_limited': {
    en: "Jupiter is rate-limiting this server right now, so the {act} was not sent — nothing was spent. Try again in a few seconds, or with fewer wallets at once.",
    id: 'Jupiter sedang membatasi request dari server ini, jadi {act}-nya tidak dikirim — tidak ada dana yang keluar. Coba lagi beberapa detik, atau pakai lebih sedikit wallet sekaligus.',
  },
  // Their side, not ours and not the token's. "Try again in a moment" is right
  // here and wrong for the two neighbours above and below it, which is the whole
  // reason these are three keys.
  'err.upstream_down': {
    en: "The router (Jupiter) is having trouble right now, so the {act} was not sent — nothing was spent. It usually clears within a minute.",
    id: 'Router-nya (Jupiter) lagi bermasalah, jadi {act}-nya tidak dikirim — tidak ada dana yang keluar. Biasanya pulih dalam semenit.',
  },
  // ⚠️ NO ROUTE IS A FACT ABOUT THE TOKEN, NOT A HICCUP ON OUR SIDE — and it
  // used to be reported as one. `no route / no liquidity for this token on
  // Jupiter` matched the `err.no_price` rule and came out as "Couldn't read
  // live pricing … please try again in a moment", under a 🔄 Try again button.
  // So a user whose token simply has no tradable pool was told to keep
  // retrying, and did: the report was two wallets, the same sentence on both,
  // over and over. "It answered with nothing" and "it did not answer" are
  // different facts — this repo's own rule, on the surface that spends money.
  // This one names what would have to change, so the retry stops.
  'err.no_route': {
    en: "No tradable route for this token — the aggregator found no pool it can {act} through. <b>Nothing was sent and nothing was spent.</b> Retrying won't change it: a token still on its launchpad curve becomes tradable only once it migrates to a pool.",
    id: 'Tidak ada rute untuk token ini — aggregator tidak menemukan pool untuk {act}. <b>Tidak ada yang dikirim dan tidak ada dana keluar.</b> Mengulang tidak akan mengubahnya: token yang masih di kurva launchpad baru bisa ditradingkan setelah pindah ke pool.',
  },
  /*
   * THE DISCOVERED LAUNCHPAD CURVE REFUSED TO BE BUILT.
   *
   * ⚠️ It needs its own key because every existing rule gets it WRONG. "the
   * curve rejected this call (execution reverted…)" matches the `reverted` in
   * the slippage rule and comes out as "the price moved" — a false diagnosis
   * about a call the chain declined outright. And a refusal that matched
   * nothing at all fell to `err.generic` ("try again in a moment"), which is
   * the exact sentence i18n.test.js exists to keep away from engine errors.
   *
   * It deliberately does NOT say "retrying won't change it", unlike no_route:
   * most of these refusals are fixed by one more trade on the pad, and a
   * sentence that tells the user to give up on a token that becomes tradable in
   * a minute is as wrong as one that tells them to keep retrying for ever.
   */
  'err.curve_refused': {
    en: "Dexvra reads a launchpad curve from its own trades, and it couldn't build a safe {act} for this one yet. <b>Nothing was sent and nothing was spent.</b> A curve usually becomes readable after a few more trades on the pad.",
    id: 'Dexvra membaca kurva launchpad dari transaksi nyatanya, dan untuk token ini belum bisa membuat {act} yang aman. <b>Tidak ada yang dikirim dan tidak ada dana keluar.</b> Biasanya kurvanya bisa dibaca setelah ada beberapa transaksi lagi di padnya.',
  },
  // Priced, then refused at the build step. Says the two things that matter:
  // nothing was signed, and it is the router's problem rather than the token's.
  'err.build_failed': {
    en: "The router priced this token but refused to build the {act} — <b>nothing was sent and nothing was spent</b>. This is usually brief: tap {btn} again, or try a smaller amount.",
    id: 'Router berhasil menghitung harga tapi menolak membuat transaksi {act}-nya — <b>tidak ada yang dikirim dan tidak ada dana keluar</b>. Biasanya sebentar: tap {btn} lagi, atau coba jumlah lebih kecil.',
  },
  'err.restricted': {
    en: "This token can't be traded yet (it may be restricted). Try a different token.",
    id: 'Token ini belum bisa ditradingkan (kemungkinan masih dibatasi). Coba token lain.',
  },
  'err.generic': {
    en: "The {act} didn't go through. Please try again in a moment.",
    id: '{act} tidak berhasil. Coba lagi sebentar lagi.',
  },
  // Nothing was sent and nothing was spent — the bot could not reach the service
  // that prices and builds the swap. Said plainly, because "try again in a
  // moment" invites a user to burn five more wallets on the same dead host, and
  // because the operator needs to know it is their server's egress, not the
  // token.
  // The guard that would have saved the trade this whole investigation started
  // from: the card said one price, the aggregator quoted three times worse, and
  // nothing compared them. Worded so the user knows their money is untouched and
  // that the token — not the bot — is the problem.
  'err.diverged': {
    en: "Refused: the real trading price is far worse than the price shown for this token, so the {act} was NOT sent and nothing was spent. That gap means the pool is much thinner than it looks or the token charges a transfer fee. Raise the limit in ⚙️ Settings only if you know what you are buying.",
    id: 'Ditolak: harga trading sebenarnya jauh lebih buruk dari harga yang ditampilkan untuk token ini, jadi {act}-nya <b>tidak</b> dikirim dan tidak ada dana yang terpakai. Selisih itu artinya pool-nya jauh lebih tipis dari kelihatannya, atau tokennya memungut transfer fee. Naikkan batasnya di ⚙️ Settings hanya kalau kamu paham token yang kamu beli.',
  },
  'err.offline': {
    en: "Couldn't reach the swap service, so the {act} was never sent — nothing was spent. This is a connection problem on our side, not the token. Try again shortly; if it keeps happening, tell an admin.",
    id: 'Layanan swap tidak bisa dihubungi, jadi {act}-nya tidak pernah dikirim — tidak ada dana yang terpakai. Ini masalah koneksi di sisi kami, bukan tokennya. Coba lagi sebentar lagi; kalau terus begini, kabari admin.',
  },
  // The router's last resort. Two keys, because "something glitched" is a claim
  // about the BOT and it was being made about upstreams that were simply down —
  // which invites an instant retry into the same dead host and takes the blame
  // for someone else's outage. Both were one hardcoded English string on a bot
  // that ships EN/ID everywhere else.
  'err.glitch': {
    en: '⚠️ Something glitched handling that — please try again in a moment.',
    id: '⚠️ Ada yang error waktu memproses itu — coba lagi sebentar lagi.',
  },
  'err.glitch_net': {
    en: "⚠️ A service the bot depends on didn't answer just then, so that didn't go through — nothing was spent. It is a connection problem on our side, not yours. Try again in a moment.",
    id: '⚠️ Layanan yang dipakai bot tidak menjawab barusan, jadi itu tidak jadi diproses — tidak ada dana yang terpakai. Ini masalah koneksi di sisi kami, bukan kamu. Coba lagi sebentar lagi.',
  },
  // Substituted into the {act} slot above, so the sentence reads naturally.
  'word.buy': { en: 'buy', id: 'buy' },
  'word.sell': { en: 'sell', id: 'sell' },
  'word.transaction': { en: 'transaction', id: 'transaksi' },

  // ---------------------------------------------------------------- language
  'lang.screen': {
    en: '🌍 <b>Language</b>\n\nChoose the language the bot replies in.\n\nCurrent: <b>{current}</b>',
    id: '🌍 <b>Bahasa</b>\n\nPilih bahasa yang dipakai bot untuk membalas.\n\nSaat ini: <b>{current}</b>',
  },
  'lang.set': { en: '✅ Language set to <b>{lang}</b>.', id: '✅ Bahasa diganti ke <b>{lang}</b>.' },
  'lang.button': { en: '🌍 Language', id: '🌍 Bahasa' },
  'lang.back': { en: '« ⚙️ Settings', id: '« ⚙️ Pengaturan' },
};

function normalize(lang) { return LANGS.includes(lang) ? lang : DEFAULT_LANG; }

/** Look up `key` in `lang`, substituting {placeholders} from `vars`.
 *  Falls back to English for a key the translation is missing, and returns the
 *  key itself if it exists in neither — a visibly wrong string beats a blank
 *  message, because a blank one ships unnoticed. */
function t(lang, key, vars) {
  const entry = S[key];
  if (!entry) return key;
  const tpl = entry[normalize(lang)] || entry.en || key;
  if (!vars) return tpl;
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? '' : String(vars[k])));
}

/** Classify a raw engine/RPC error into a translation key. Kept separate from the
 *  rendering so the (regex-heavy, easy-to-get-wrong) matching is testable on its
 *  own and shared by every language. */
function errorKey(raw) {
  const m = String((raw && (raw.message || raw)) || '').toLowerCase();
  // FIRST, because a transport failure can carry words the trade rules also
  // match — "no answer before the timeout" is not an unconfirmed transaction,
  // and telling someone to "check your wallet before trying again" when nothing
  // was ever sent is the worst of the available answers. These markers (undici's
  // bare `fetch failed`, our own `can't reach <host>`, and the syscall codes)
  // never appear in an on-chain revert.
  if (/can't reach |fetch failed|enotfound|eai_again|econnrefused|econnreset|und_err|getaddrinfo|network error/.test(m)) return 'err.offline';
  // Refused BEFORE signing, so it belongs with the "nothing was sent" class and
  // not with slippage — the trade did not fail, it was declined.
  if (/worse than the price shown/.test(m)) return 'err.diverged';
  if (/token balance is 0|no bag/.test(m)) return 'err.no_bag';
  if (/insufficient|need ~|exceeds balance/.test(m)) return 'err.insufficient';
  if (/max fee per gas|base fee|underpriced|replacement|nonce/.test(m)) return 'err.gas_moved';
  // BEFORE the slippage rule, which matches on the word "reverted" and would
  // otherwise report a call the chain DECLINED as a price that moved — sending
  // the user to widen a slippage setting that had nothing to do with it.
  if (/launchpad curve|the curve rejected this call|curve needs an allowance|no independent price/.test(m)) return 'err.curve_refused';
  if (/thin pool|price impact|slippage|reverted|iia|too little received/.test(m)) return 'err.slippage';
  if (/not confirmed|timeout|pending/.test(m)) return 'err.unconfirmed';
  // BEFORE the no_price rule, which would otherwise swallow it: "no liquidity"
  // appears in both, and only this one means the token cannot be traded at all.
  // `no pool? try again` is deliberately NOT here — that is a pool READ that
  // failed, which is ours and is worth retrying.
  // "can't route through yet" is the SAME fact and had been falling to
  // err.generic — "try again in a moment" under a Try again button, for a
  // condition that does not change until the token migrates. It is the very
  // defect the comment above this key describes, on the sentence that produces
  // it most often.
  if (/no route|no liquidity \/ zero quote|not tradable|can't route through/.test(m)) return 'err.no_route';
  // ⚠️ EVERY ONE OF THESE USED TO BE 'err.no_price', BECAUSE THE WORD `quote` IS
  // IN THE MESSAGE. `Jupiter quote failed (429)`, `(400)` and `(503)` are three
  // different facts — our request budget, the token, and Jupiter — and they were
  // rendered as one sentence telling the user to try again in a moment. For the
  // 400 that is the very defect the `err.no_route` comment above describes,
  // reached through the HTTP status instead of through an empty quote: the
  // parsed-empty door was shut and this one was left open. Ordered before the
  // no_price rule for exactly that reason, and 400 is checked FIRST because
  // Jupiter's own refusal codes are the most specific thing in the string.
  if (/could_not_find_any_route|token_not_tradable|no routes found|could not find any route|not tradable/.test(m)) return 'err.no_route';
  if (/rate.?limit|\(429\)|too many requests/.test(m)) return 'err.rate_limited';
  // ⚠️ A SWAP-BUILD 5xx KEEPS ITS OWN KEY, and this order is the whole reason
  // the generic upstream rule below it is safe to add. `err.build_failed` exists
  // for exactly this status on exactly this endpoint — Jupiter PRICED the token
  // and then refused to build the transaction, which the v6-vs-v1 body spelling
  // produced in production as a 500 — and it says the more useful thing ("try a
  // smaller amount") than "their side is down". A more specific fact must not be
  // swallowed by a rule written for the general one.
  if (/swap-build (failed|is unavailable)|returned no swap transaction/.test(m)) return 'err.build_failed';
  if (/is unavailable \(5\d\d\)|\(50[0-4]\)|bad gateway|service unavailable|gateway time/.test(m)) return 'err.upstream_down';
  if (/could not (read|price)|pool read|quote|no pool|no liquidity/.test(m)) return 'err.no_price';
  if (/private beta|not allowed|notallowed/.test(m)) return 'err.restricted';
  // THE AGGREGATOR PRICED IT AND THEN REFUSED TO BUILD THE TRANSACTION. A
  // different fact from "no route" (it quoted) and from slippage (nothing was
  // signed), and the strings are this repo's own — solana.js throws both. They
  // matched nothing and came out as the generic "try again in a moment", which
  // is what a user saw on all five wallets at once with no way to tell whether
  // their money had moved. `swapBody`'s v6-vs-v1 spelling produced exactly this
  // in production once already; see the note in solana.js.
  // Sent, and the chain rejected it. Belongs with the revert family, not with
  // "nothing happened": the signature fee is spent either way.
  if (/transaction failed on-chain|failed on-chain/.test(m)) return 'err.slippage';
  return 'err.generic';
}

/** One clear, localized sentence for a failed trade. `action` is 'buy'|'sell'. */
/** The parenthetical a curve refusal carries — the STAGE that refused. */
function _stageOf(raw) {
  const m = String((raw && (raw.message || raw)) || '');
  const hit = /launchpad curve \(([^)]{3,300})\)/.exec(m) || /the curve rejected this call \(([^)]{3,300})\)/.exec(m);
  return hit ? hit[1].trim() : null;
}
const _escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function errorText(lang, raw, action) {
  const key = errorKey(raw);
  const act = t(lang, action === 'buy' ? 'word.buy' : action === 'sell' ? 'word.sell' : 'word.transaction');
  // 'err.gas_moved' names the BUTTON to press, which is capitalised UI, not a noun.
  const btn = action === 'buy' ? 'Buy' : 'Sell';
  const body = t(lang, key, { act, btn });
  /*
   * ⚠️ AND THE STAGE THAT REFUSED RIDES ALONG, for a curve refusal.
   *
   * The friendly sentence swallowed `prep.why` entirely, so every refusal on
   * this route read as the same "a few more trades on the pad" whatever
   * actually stopped it — the price, the classify, the simulate. That is the
   * "a value nobody can read is the same as no value" defect on the money
   * path, and the card had to learn it first (`curveWhy`): four rounds of
   * "masih sama aja" began with a message that named no stage.
   *
   * The template is OURS and carries markup; only this appended fragment comes
   * from an error, so only this is escaped.
   */
  const stage = key === 'err.curve_refused' ? _stageOf(raw) : null;
  return stage ? `${body}\n<i>${_escHtml(stage)}</i>` : body;
}

module.exports = { t, errorKey, errorText, normalize, LANGS, DEFAULT_LANG, LANG_LABEL, _strings: S };
