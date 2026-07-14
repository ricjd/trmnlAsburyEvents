# trmnl-asbury-events

A free Cloudflare Worker that reads the private "Asbury Beach House" Google
Calendar and pushes an upcoming-events agenda to a
[TRMNL](https://docs.trmnl.com) private plugin via its webhook API. Runs
hourly.

```
Google Calendar  --(service account)-->  Cloudflare Worker  --(webhook)-->  TRMNL plugin
```

Same architecture as [trmnlBdays](https://github.com/ricjd/trmnlBdays), the
birthdays version — separate repo because it's a different calendar,
different TRMNL plugin, and independent deploy/cron schedule, at the cost of
duplicating the ~40 lines of Google auth code.

## Adaptive day window

The house calendar isn't evenly busy, so a fixed "next 2 days" or "next 7
days" window would either look empty or get clipped depending on the week.
Instead the Worker fetches the next 20 events (`MAX_EVENTS_FETCHED` in
`src/index.js`) and picks how many days to display:

- Always show **at least 2 days** (`MIN_DAYS`).
- If that doesn't add up to **~6 events** (`TARGET_EVENT_COUNT`), keep
  expanding the window a day at a time.
- Stop expanding once the target is hit, there are no more fetched events
  left to gain, or the window hits a **14-day ceiling** (`MAX_DAYS`) —
  whichever comes first.

That ceiling is a deliberate tradeoff: if the calendar is very sparse (say,
one event three weeks out and nothing else), the screen will show "no
upcoming events" rather than a window that keeps growing to "next 3
months." Adjust `MAX_DAYS`/`TARGET_EVENT_COUNT`/`MIN_DAYS` in
`src/index.js` if that tradeoff doesn't fit how the house actually gets
used.

Empty days inside the window aren't shown — only day-buckets that actually
have at least one event get a header.

## 1. Google Cloud: create a service account

You can reuse the same service account from the birthdays project (skip to
step 2) if you'd rather not manage two, or create a fresh one:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a new project (or reuse one).
2. **APIs & Services → Library** → enable the **Google Calendar API**.
3. **APIs & Services → Credentials → Create Credentials → Service account**.
   No project-level roles needed.
4. Open the service account → **Keys → Add key → Create new key → JSON**.
   Keep the downloaded file secret.
5. Note the service account's email address.

## 2. Share the calendar with the service account

1. In [Google Calendar](https://calendar.google.com), open **Settings** for
   the Asbury Beach House calendar.
2. Under **Share with specific people**, add the service account's email
   with **"See all event details"**.
3. Under **Integrate calendar**, copy the **Calendar ID**.

## 3. TRMNL: create the private plugin

1. In TRMNL, go to **Plugins → Private Plugin → Add New**.
2. Set **Strategy** to **Webhook**.
3. Open the **Markup Editor**. It has one tab per layout size — paste the
   matching file into each tab you plan to use:
   - **Full** (800x480) → [`trmnl/full.liquid`](trmnl/full.liquid)
   - **Half vertical** (400x480) → [`trmnl/half_vertical.liquid`](trmnl/half_vertical.liquid)
   - **Half horizontal** (800x240) → [`trmnl/half_horizontal.liquid`](trmnl/half_horizontal.liquid)
   - **Quadrant** (400x240) → [`trmnl/quadrant.liquid`](trmnl/quadrant.liquid)

   Use the live preview in each tab to check for clipping on a busy day.
4. Copy the plugin's **webhook URL** — you'll need it below. Note TRMNL's
   webhook limits: 12 requests/hour and 2KB per payload on a free account.

## 4. Deploy the Cloudflare Worker

Requires a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
and Node.js installed locally.

```bash
cd trmnlAsburyEvents
npm install
npx wrangler login
```

Edit `wrangler.toml`'s `TIMEZONE` var if the house isn't in
`America/New_York` — used to bucket events into days and format times.
Edit `PLUGIN_TITLE` to rename the on-device title (e.g. "Family
Calendar" instead of "Beach House") — no Liquid changes needed, all
four templates read it from the webhook payload.

Set the secrets:

```bash
# Pipe the file in directly rather than pasting interactively — the
# wrangler prompt reads a single line, and Google's downloaded key file is
# multi-line, so an interactive paste will silently truncate it.
cat /path/to/service-account-key.json | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON

npx wrangler secret put GOOGLE_CALENDAR_ID   # the calendar ID from step 2
npx wrangler secret put TRMNL_WEBHOOK_URL
npx wrangler secret put WORKER_AUTH_TOKEN   # any random string, protects the manual /run endpoint
```

Deploy:

```bash
npx wrangler deploy
```

## 5. Test it

```bash
curl "https://trmnl-asbury-events.<your-subdomain>.workers.dev/run?token=<WORKER_AUTH_TOKEN>"
```

A successful response shows the computed agenda (days, window size, event
count). Check the TRMNL plugin preview to confirm the screen rendered.
Watch live logs during a real cron fire with `npx wrangler tail`, or
trigger the cron on demand from **Workers & Pages → trmnl-asbury-events →
Triggers → Cron Triggers → Trigger Event** in the Cloudflare dashboard.

## How it works

- `src/index.js` — the Worker. On each cron fire (or a manual `/run` hit)
  it signs a JWT with the service account's private key (via the Workers
  Web Crypto API), exchanges it for a Google OAuth access token, fetches up
  to 20 events over the next 14 days, buckets them into calendar days using
  `Intl.DateTimeFormat` in the configured timezone (so a late-night event
  doesn't get miscounted into the next UTC day), runs the adaptive window
  logic described above, and POSTs the result to the TRMNL webhook as
  `merge_variables`.
- `trmnl/*.liquid` — one Liquid template per layout size, each grouping
  events under day headers ("Today", "Tomorrow", "Fri" ...), sized to fit
  that layout's space. `half_horizontal` and `quadrant` only show the
  first one or two day-buckets given their limited height.

## Notes / things to revisit

- Both all-day (`event.start.date`) and timed (`event.start.dateTime`)
  events are handled; timed events show a formatted time range, all-day
  events show "All day".
- Event titles are truncated to 60 characters to help stay under the 2KB
  webhook payload cap.
- If you ever want to dedupe the Google-auth code between this repo and
  the birthdays one, it's the `getAccessToken`/`base64url`/
  `pemToArrayBuffer` block near the top of `src/index.js` — identical in
  both.
