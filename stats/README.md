# Install counter

This is everything OpenCursor's anonymous install count does. It runs as a Cloudflare Worker at `opencursor-stats.opencursor.workers.dev`.

**What the app sends, once a day:** a random ID it creates on first launch (not based on you or your computer), the OpenCursor version, and the OS and processor. See `extensions/open-cursor/src/stats/installCount.ts`.

**What is stored:** a SHA-256 hash of that ID, the first and last day it was seen, its version and OS, and which days it was active. IP addresses are not stored and requests are not logged. To keep one network from flooding the counter or the report inbox, a one way hash of the address (salted with a server secret and the day, so it means nothing the next day) is kept with a count for about three days, then deleted. See `migrations/0001_init.sql` and `migrations/0003_ip_limits.sql`.

**Deploying:** apply the migrations first (`wrangler d1 migrations apply opencursor-stats --remote`), then deploy the worker. If the worker goes out first the network limits are simply off until the table exists.

**What is never sent:** your name, email, files, code, chats, prompts or API keys.

**Turning it off:** Settings > General > Privacy > Anonymous install count, or set `openCursor.privacy.anonymousCount` to `false`. It is also off whenever the editor's `telemetry.telemetryLevel` is `off`.

The totals are shown to the maintainer on a page protected by a secret key.
