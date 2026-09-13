// Every user-visible brand string routes through these constants — never
// hardcode them in components, so a rename is a one-file change.
export const BRAND_NAME = "Dexvra";
export const BRAND_SUB = "Discovery";
export const BRAND_MARK = "D"; // logo monogram letter
export const BRAND_TAGLINE = "Find the next Moonshot";
export const BRAND_DOMAIN = "dexvra.io";

// Social destinations — defined in ./socials beside the channel list they
// describe, and re-exported here so the many callers that just want BOT_URL
// keep importing from one obvious place. Handles match the accounts the bot
// posts from (its CHANNELS config and X_HANDLE) and the ones printed on the
// channel artwork.
export {
  BOT_URL, // every "List Token" CTA leads here
  TELEGRAM_URL,
  TELEGRAM_HANDLE,
  TELEGRAM_LISTING_URL,
  TELEGRAM_LISTING_HANDLE,
  TELEGRAM_TRENDING_URL,
  TELEGRAM_TRENDING_HANDLE,
  X_URL,
  X_LISTING_URL,
  X_LISTING_HANDLE,
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,
} from "./socials.ts";
