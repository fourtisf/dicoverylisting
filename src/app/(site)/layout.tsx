import type { ReactNode } from "react";
import { BOT_URL, BRAND_NAME, SUPPORT_EMAIL, SUPPORT_MAILTO, TELEGRAM_TRENDING_URL, TELEGRAM_URL, X_LISTING_URL, X_URL } from "@/config/brand";
import { within } from "@/lib/cache";
import { getFearGreed, getTokensPayload } from "@/lib/providers";
import { AppProvider } from "@/components/AppState";
import { WalletModal } from "@/components/WalletModal";
import { ListingModal } from "@/components/ListingModal";
import { PwaRegister } from "@/components/PwaRegister";
import { Ticker } from "@/components/Ticker";
import { Toast } from "@/components/Toast";
import { Topbar } from "@/components/Topbar";

// Public site shell — top-navigation, one column. The sidebar was the old
// identity's strongest structural signature; navigation lives in the header
// now (primary links inline, everything else behind the ⋮ menu, which
// Sidebar.tsx still feeds via NAV_GROUPS). The admin panel (/panel) lives
// outside this group and never renders any of it.
/**
 * ⚠️ RENDERED PER REQUEST, because it now carries data.
 *
 * These pages were prerendered at build time, which is only fast in the way a
 * photograph of a board is fast: the HTML held skeleton rows, and the real
 * numbers were three serial steps away (bundle → hydrate → fetch). Left static
 * with a data fetch in it, the board would instead be frozen at whatever the
 * market looked like when somebody last ran `npm run build`, which is worse
 * than either.
 */
export const dynamic = "force-dynamic";

/**
 * How long server rendering may wait for the two payloads.
 *
 * ⚠️ SHORT, AND FAILURE IS FREE. Both are cache reads that answer in
 * microseconds once anything is warm (lib/cache serves an expired entry
 * instantly), so this only ever binds on a cold process — and there the honest
 * answer is to ship the shell and let the client fetch, which is exactly what
 * the page did before any of this. Seeding the state can make the first paint
 * earlier; it must never be able to make the response slower than the static
 * shell it replaced.
 */
const SSR_WAIT_MS = 1_200;

async function seed() {
  try {
    const [tokens, fng] = await Promise.all([
      within(getTokensPayload(), SSR_WAIT_MS),
      within(getFearGreed(), SSR_WAIT_MS),
    ]);
    return {
      initialData: tokens.ok ? tokens.value : null,
      initialFng: fng.ok ? fng.value : null,
    };
  } catch {
    // The client fetches both on mount regardless, so a server-side failure
    // costs the head start and nothing else.
    return { initialData: null, initialFng: null };
  }
}

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const { initialData, initialFng } = await seed();
  return (
    <AppProvider initialData={initialData} initialFng={initialFng}>
      <div className="app">
        <div className="main">
          <Topbar />
          <Ticker />
          <main className="content">
            {children}
            <footer className="foot">
              <span>© 2026 {BRAND_NAME} · DYOR — nothing here is financial advice.</span>
              {/* These were <a> tags with no href: they looked like links, hovered
                  like links, and went nowhere. Docs/API have no page yet, so they
                  are plain text until they do — the social ones are real. */}
              <span className="links">
                <span className="foot-soon">Docs</span>
                <span className="foot-soon">API</span>
                <a href={X_LISTING_URL} target="_blank" rel="noopener noreferrer">Listing alerts on X</a>
                <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
                <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer">Telegram</a>
                <a href={TELEGRAM_TRENDING_URL} target="_blank" rel="noopener noreferrer">Trending</a>
                {/* "All channels" (→ /community) was removed at the operator's
                    request — the socials above are the real destinations. */}
                <a href={BOT_URL} target="_blank" rel="noopener noreferrer">Bot</a>
                {/* The ADDRESS is the label, not the word "Support": a reader
                    who cannot open a mail client (a phone with none set up,
                    a locked-down desk) can still read it and copy it. */}
                <a href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</a>
              </span>
            </footer>
          </main>
        </div>
      </div>
      <ListingModal />
      <WalletModal />
      <Toast />
      <PwaRegister />
    </AppProvider>
  );
}
