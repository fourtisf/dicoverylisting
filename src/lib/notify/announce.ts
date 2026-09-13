// Server-only. Best-effort by design: a failed post is a false return value,
// never an exception, because a cron run must not fail over a channel outage.
import type { PonsLaunchFeedItem } from "@/lib/providers/pons";
import { launchAnnouncement } from "./messages";
import { sendTelegram } from "./telegram";

export const announceLaunch = (launch: PonsLaunchFeedItem): Promise<boolean> =>
  sendTelegram(launchAnnouncement(launch));
