# Cloudflare Workers edition

This is an independent TypeScript implementation of the existing Railway Telegram bot. **The Python bot and all Railway files are unchanged.** It uses Telegram webhooks instead of polling, D1 instead of JSON files, an optional private R2 bucket instead of local image files, and a one-minute Cloudflare Cron Trigger instead of an always-running Python process. No Cloudflare deployment or real Telegram credentials are included.

## Deploy

Use Node.js 22 or newer and a Cloudflare account with Workers and D1 enabled. R2 is optional and may require enabling R2 on the account. Small workloads use conservative batch sizes; **Workers Paid is recommended** for reliable CPU headroom during CSV parsing and growing notification fan-out. Check the current account's resource limits rather than assuming unlimited free operation.

```bash
cd worker
npm ci
npm run typecheck
npm test
npx wrangler login
npx wrangler d1 create book-search
npx wrangler r2 bucket create book-search-covers
```

Copy the `database_id` returned by D1 into `wrangler.jsonc`. If you do not want R2, remove `r2_buckets` from the configuration; text cards and Telegram `file_id` reuse still work, but raw covers are downloaded again when a reusable Telegram photo ID is unavailable. Bucket objects are not public; the Worker only exposes `/covers/<image_id>` for images already in the catalog.

If you will import existing Railway state, set `triggers.crons` to `[]` **before this first deployment**, then follow the cutover/import section below before enabling cron or the webhook.

Set secrets interactively (never put them in Git or `wrangler.jsonc`):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_OWNER_ID
npm run db:remote
npm run deploy
```

Use a strong random `TELEGRAM_WEBHOOK_SECRET` containing only letters, digits, `_`, or `-` (1–256 characters). `TELEGRAM_OWNER_ID` is your numeric Telegram user ID, not a username. **Owner commands are disabled if this ID is missing**, unlike the original permissive behavior. `BOT_USERNAME` defaults to `saroatsarpay_bot` and is verified via Telegram `getMe`, then stored in D1. Do not reuse the same D1 catalog/file IDs with a different bot token without clearing `meta.bot_username` and `cover_cache.file_id`.

Set `PUBLIC_BASE_URL` in `wrangler.jsonc.vars` to the returned HTTPS Worker origin and redeploy if you want R2 image URLs for inline photos. First refresh runs on the next cron tick and deliberately treats all existing rows as an initial baseline without notifying every subscriber. Later refreshes enqueue only previously unseen normalized title/author pairs. `/refresh` in the owner's DM requests a refresh on the next tick and edits the progress message after completion.

Before switching the production bot, **stop the Railway polling service**. Telegram cannot run `getUpdates` while a webhook exists. Set the webhook using shell environment variables (the helper does not print secrets):

```bash
# Set these in your shell without storing real values in source control:
export TELEGRAM_BOT_TOKEN='YOUR_TOKEN'
export TELEGRAM_WEBHOOK_SECRET='YOUR_WEBHOOK_SECRET'
export PUBLIC_BASE_URL='https://myanmar-book-search-bot.YOUR_SUBDOMAIN.workers.dev'
npm run webhook -- set
npm run webhook -- status
```

The helper sets `max_connections=1`, preserves pending updates, and enables `message`, `callback_query`, `inline_query`, and `my_chat_member` updates. Verify `/health`, then `/start`, `/stats`, `/books`, a book card, its summary/order buttons, and `/demo` in the owner DM. Check `getWebhookInfo` for errors and `npx wrangler tail` for runtime failures. Secrets in your shell must match Wrangler secrets; `.dev.vars` is for local development only, not automatically read by this helper or deployed as production secrets.

Enable inline mode in BotFather with `/setinline`. For groups, add the bot as administrator or disable privacy with `/setprivacy` if you need it to receive ordinary `@mention` searches. Telegram privacy settings can prevent delivery before the Worker has a chance to route the message. Group auto-delete needs permission to delete the bot's own replies.

## Preserve Railway state at cutover

Stop Railway, privately download a copy of `STATE_DIR` (usually `/data`), and keep it out of Git. On a fresh D1 database, apply both migrations before import. **Temporarily change `triggers.crons` to `[]` and deploy before importing**, so the first refresh cannot race the import. Do not enable the webhook yet.

```bash
npm run import:railway -- /path/to/private-state-copy /path/to/private-import.sql
npx wrangler d1 execute book-search --remote --file=/path/to/private-import.sql
# Restore triggers.crons to ["* * * * *"], deploy, then set the webhook.
```

The offline converter imports `known_books.json`, `subscribers.json`, `bot_groups.json`, `publisher_channels.json`, `book_file_ids.json`, and `usage.json` when present. Import only once into a fresh database: importing over a running bot can overwrite newer opt-outs, analytics, links, and cache state. Subscriber IDs and usage data are personal data; protect the generated SQL and delete the local copy when no longer needed. The old analytics file only has total searches and a set of search users, so individual per-user historical search totals cannot be recovered exactly; aggregate totals and unique searcher counts are preserved.

When imported known-book IDs exist, the first Workers refresh uses them as the baseline and notifies only books added since that snapshot. A completely fresh installation without an imported baseline starts silently.

Book IDs are now **stable 32-character hashes** of normalized title + author, so refresh sorting no longer breaks cards, search state, or summary deep links. The first CSV load also records legacy numeric IDs as a best-effort compatibility mapping. For exact old `summary_<number>` links, optionally include `books_snapshot.json` containing the original `store.books` list from just before shutdown in your state copy. This snapshot is not one of the original persisted files; it must be captured from the running Python process or a same-data reconstruction. Without it, numeric links are only as accurate as the first-refresh row order; all newly issued links are stable.

## Features

All commands are implemented: `/start`, `/help`, `/stats`, `/usage`, `/refresh`, `/get`, `/addpublisher`, `/books`, `/publishers`, `/subscribe`, `/unsubscribe`, `/demo`. Search uses NFKC normalization, removes spaces/punctuation, merges original publisher aliases, deduplicates normalized title/author, and retains the original score priorities and 100-result cap. The parser handles CSV quoted commas/newlines and incomplete rows and does not accidentally discard a valid second data row if the sheet's spacer is removed.

Private text searches work without addressing the bot. **Groups respond only to an actual `@bot_username` mention or `/get`**, including `/get@bot_username`. Other group commands must be addressed, for example `/books@bot_username` or `@bot_username /stats`. Unaddressed `/books`, `/start`, other slash commands, and ordinary group chatter receive no reply. This intentionally follows the stricter migration requirement; the original Python command handlers accepted unaddressed commands. Group membership and supergroup migration are remembered durably.

Lists have ten results per page, publisher drill-down, shared callback navigation usable by any group member, one active book card per list, back-to-list buttons, and replaceable private summary views. D1 leases reduce duplicate rapid taps across isolates; if another tap owns a list lease, the tap is acknowledged without replaying it. Search/list keys include **both chat ID and message ID**, avoiding the original cross-chat message-ID collision. Private state expires after seven days by default; old or deleted buttons safely request a fresh search. Inactive book rows are retained so existing stable summary links remain useful even after removal from the sheet.

Book cards show author, title, publisher, price, edition, optional genre/month, and an order link when configured. Description buttons open the bot's DM from groups and inline messages; in DMs they send the full description via callback. Long descriptions are split into messages up to 12,000 characters; larger ones are sent as a UTF-8 text document with the full content. Captions and button labels are bounded for Telegram's limits.

Inline results are paginated ten at a time (Telegram's API does not accept the original 100-result payload). A known Telegram `file_id` or cached public Worker cover URL produces a photo card; otherwise an **article/text result** with the same book details and summary/order buttons is used. This avoids dependence on Telegram fetching unreliable Google Drive export URLs on the first use. Chosen inline messages are not auto-deleted because the bot generally has no destination chat/message ID or deletion permission for them.

DM users auto-subscribe on first interaction, `/start` or `/subscribe`; **an explicit `/unsubscribe` remains respected on later ordinary searches**. Groups and enabled DM subscribers receive queued new-book cards. The first load is silent, known-book detection survives redeploys, and `NOTIFY_MAX_PER_REFRESH` defaults to the original 25-book limit. All seen books are marked known even when the per-refresh notification cap suppresses excess books, as in Python. Notification targets are captured at refresh time; a user who subscribes later does not receive the earlier backlog, and a user who opts out before delivery is skipped. Blocked DMs and permanently inaccessible groups are removed/disabled; transient failures use capped retries and Telegram `retry_after`. `/demo` queues a randomly selected book to remembered groups and the invoking owner chat, not to every subscriber.

## Configuration and operations

`wrangler.jsonc.vars` contains non-secret defaults. Optional `SHEET_CSV_URL` overrides the same public Google Sheets CSV URL used by Python. Optional `NOTIFY_GROUP_ID` seeds one fixed group. `REFRESH_HOURS` defaults to `6` (set `1` for hourly). The cron still runs every minute to drain durable work and auto-delete; refresh failures retain the last-good catalog and retry no more often than every five minutes unless an owner requests a refresh.

`AUTO_DELETE_SECONDS=300` schedules group-only deletion in D1. Actual deletion is normally **five to six minutes after sending**, not an exact five-minute timer: cron timing, downtime, rate limits, permissions, and deletion backlog can delay it. Pagination/book interactions extend the corresponding message's deletion deadline. DM messages are not deleted automatically. No in-memory long-lived process, local filesystem, or background sleep is relied on for durability.

`NOTIFICATION_BATCH=3`, `DELETE_BATCH=5`, `INBOX_BATCH=2`, and `WARM_COVERS_PER_TICK=1` conservatively bound work per cron invocation. Default notification throughput is roughly three cards per minute across all recipients. Increase the notification batch (maximum 20), reduce or disable cover warm-up, and use Workers Paid for a larger audience. A genuinely high-volume bot should move fan-out to Cloudflare Queues rather than making unbounded requests in a webhook. Keep an eye on pending/failed counts in owner `/usage` and on D1 size/cost. D1 outbox failures remain for 30 days; done/failed inbox rows remain seven days; daily active usage is retained 90 days; ever-started/unique searchers, opt-outs, books and known IDs are retained until deliberately removed. Respect applicable privacy requirements and delete user rows when requested.

The webhook acknowledges only after storing an update in D1. It then attempts immediate processing with `ctx.waitUntil`; unfinished jobs are recovered by cron after the lease expires. **Exactly-once Telegram delivery is impossible** without Telegram-side idempotency: a crash after sending but before committing completion can produce a duplicate reply/notification. D1 update-ID deduplication prevents normal webhook retry duplicates; leases and deterministic outbox keys prevent most parallel duplicates. Expired inline/callback queries are discarded after a minute rather than replaying obsolete UI actions. Transient updates retry six times and notifications eight times before being marked failed. `/usage` exposes failed counts; inspect `inbox.last_error` and `outbox.last_error` with Wrangler and selectively requeue failed rows after fixing the underlying issue. Do not blindly retry a broadcast without checking whether Telegram already accepted it.

R2 stores validated JPEG/PNG/WebP bytes with a 5 MiB download cap and uses the Drive 640px thumbnail first. **No Pillow JPEG conversion/resizing occurs on Workers**; if Telegram rejects an unusual/oversized image or Drive access fails, a text card is the safe fallback. Invalid cached Telegram photo IDs are cleared and fetched again. R2 failure also falls back to Drive/text instead of failing the whole search. Cover warm-up is incremental, not four permanent Python background workers. Covers/files remain cached until the operator deletes them; if an image changes under the same Drive ID, purge `covers/<id>` and its `cover_cache` row to force refetching. The bot does not send an owner startup notification on every isolate start (there is no single server startup); use deploy output, `/health`, `/stats`, logs, and `/demo` instead.

## Local validation

```bash
cp .dev.vars.example .dev.vars
# Edit the local placeholders; do not expose this file.
npm run db:local
npm run dev
curl http://localhost:8787/health
curl 'http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*'
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

Use a separate test bot for local webhook experimentation. The automated tests use fake credentials, mocked external HTTP calls, and real local Miniflare D1/R2 bindings. They test normalization, CSV edge cases, stable IDs, search ranking, group gating, fail-closed owner access, subscription opt-out, initial/new-book refresh behavior, invalid refresh retention, durable list state, deletion, R2 caching, authenticated webhook ingress, and update deduplication. No test sends a real Telegram message.

To roll back, run `npm run webhook -- delete`, disable the Workers cron before resuming Railway, and restart the original polling service. State created on Workers is not automatically exported back to Railway; plan a reverse export if new subscribers or publisher links need to be retained.

## Platform references

[Telegram Bot API](https://core.telegram.org/bots/api), [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [D1 transactional batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/), and [Workers resource limits / 30-second HTTP waitUntil window](https://developers.cloudflare.com/workers/platform/limits/) describe the external contracts underlying the safe fallbacks above.
