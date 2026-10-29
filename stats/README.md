# Install counter

This is everything OpenCursor's anonymous install count does. It runs as a Cloudflare Worker at `opencursor-stats.opencursor.workers.dev`.

**What the app sends, once a day:** a random ID it creates on first launch (not based on you or your computer), the OpenCursor version, and the OS and processor. See `extensions/open-cursor/src/stats/installCount.ts`.

**What is stored:** a SHA-256 hash of that ID, the first and last day it was seen, its version and OS, and which days it was active. IP addresses are not stored and requests are not logged. See `migrations/0001_init.sql`.

**What is never sent:** your name, email, files, code, chats, prompts or API keys.

**Turning it off:** Settings > General > Privacy > Anonymous install count, or set `openCursor.privacy.anonymousCount` to `false`. It is also off whenever the editor's `telemetry.telemetryLevel` is `off`.

The totals are shown to the maintainer on a page protected by a secret key.
