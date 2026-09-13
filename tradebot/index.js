'use strict';
/* Dexvra Trade Bot entrypoint — starts the Telegram UI + background watchers. */
require('./telegram').start().catch((e) => { console.error('fatal', e); process.exit(1); });
