/**
 * Pulls upcoming events from a private Google Calendar (a shared house
 * calendar) and pushes an adaptive-length agenda to a TRMNL private plugin
 * webhook as merge variables.
 *
 * Adaptive window: always show at least MIN_DAYS days. If that doesn't add
 * up to TARGET_EVENT_COUNT events, keep expanding day-by-day (up to
 * MAX_DAYS) until it does, or until there are no more fetched events left
 * to gain by expanding further.
 *
 * Auth: Google service account (JWT Bearer flow), signed with the Workers
 * Web Crypto API — no googleapis/Node dependency required.
 */

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const MAX_EVENTS_FETCHED = 20; // "pull the next 20 events"
const MIN_DAYS = 2;
const MAX_DAYS = 14;
const TARGET_EVENT_COUNT = 6;

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("OK. Trigger manually at /run?token=<WORKER_AUTH_TOKEN>", { status: 200 });
    }

    if (!env.WORKER_AUTH_TOKEN || url.searchParams.get("token") !== env.WORKER_AUTH_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const result = await run(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  },
};

async function run(env) {
  const timezone = env.TIMEZONE || "America/New_York";
  const serviceAccount = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const accessToken = await getAccessToken(serviceAccount);
  const events = await fetchUpcomingEvents(accessToken, env.GOOGLE_CALENDAR_ID);
  const agenda = buildAgenda(events, timezone);

  const trmnlResp = await fetch(env.TRMNL_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      merge_variables: {
        days: agenda.days,
        window_days: agenda.windowDays,
        event_count: agenda.eventCount,
        plugin_title: env.PLUGIN_TITLE || "Beach House",
        generated_at: new Date().toISOString(),
      },
    }),
  });

  if (!trmnlResp.ok) {
    throw new Error(`TRMNL webhook failed: ${trmnlResp.status} ${await trmnlResp.text()}`);
  }

  return agenda;
}

function parseServiceAccount(raw) {
  if (!raw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret is not set (empty/undefined).");
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (length ${raw.length}, starts "${raw.slice(0, 15)}..."): ${err.message}`
    );
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON parsed but is missing client_email/private_key. Keys found: ${Object.keys(serviceAccount).join(", ")}`
    );
  }
  return serviceAccount;
}

async function getAccessToken(serviceAccount) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope: CALENDAR_SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${base64url(signature)}`;

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Google token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.access_token;
}

async function fetchUpcomingEvents(accessToken, calendarId) {
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + MAX_DAYS * 86400000).toISOString();

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  );
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(MAX_EVENTS_FETCHED));

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    throw new Error(`Google Calendar API failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.items || [];
}

export function buildAgenda(events, timezone, now = new Date()) {
  const todayKey = dayKeyInZone(now, timezone);
  const anchorUTC = dateKeyToUTC(todayKey);

  const dayKeyAtOffset = (offset) =>
    new Date(anchorUTC + offset * 86400000).toISOString().slice(0, 10);

  const enriched = events
    .filter((e) => e.start && (e.start.date || e.start.dateTime))
    .map((e) => {
      const allDay = !!e.start.date;
      const dayKey = allDay ? e.start.date : dayKeyInZone(new Date(e.start.dateTime), timezone);
      return {
        title: (e.summary || "Untitled event").slice(0, 60),
        dayKey,
        time: allDay ? "All day" : formatTimeRange(e.start.dateTime, e.end && e.end.dateTime, timezone),
        sortKey: allDay ? `${dayKey}T00:00` : e.start.dateTime,
      };
    });

  // Only ever consider events from today onward. In production this is
  // already guaranteed by the Calendar API's timeMin=now, but buildAgenda
  // shouldn't silently rely on that — it takes an injectable `now` for
  // testing, and the two could diverge.
  const futureEvents = enriched.filter((e) => e.dayKey >= todayKey);

  // Grow the window from MIN_DAYS until we hit the target event count, run
  // out of fetched events to gain, or hit the MAX_DAYS ceiling.
  let windowDays = MIN_DAYS;
  for (let n = MIN_DAYS; n <= MAX_DAYS; n++) {
    windowDays = n;
    const lastKey = dayKeyAtOffset(n - 1);
    const count = futureEvents.filter((e) => e.dayKey <= lastKey).length;
    if (count >= TARGET_EVENT_COUNT || count >= futureEvents.length) break;
  }

  const windowLastKey = dayKeyAtOffset(windowDays - 1);
  const inWindow = futureEvents.filter((e) => e.dayKey <= windowLastKey);

  const byDay = new Map();
  for (const e of inWindow) {
    if (!byDay.has(e.dayKey)) byDay.set(e.dayKey, []);
    byDay.get(e.dayKey).push(e);
  }

  const days = [...byDay.keys()]
    .sort()
    .map((dayKey) => {
      const dayEvents = byDay.get(dayKey).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
      return {
        label: dayLabel(dayKey, todayKey),
        date: formatDayDate(dayKey),
        events: dayEvents.map((e) => ({ title: e.title, time: e.time })),
      };
    });

  return { days, windowDays, eventCount: inWindow.length };
}

function dayKeyInZone(date, timezone) {
  // en-CA formats as YYYY-MM-DD, which sorts and compares lexically like a date.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dateKeyToUTC(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function dayLabel(dayKey, todayKey) {
  if (dayKey === todayKey) return "Today";
  const tomorrowKey = new Date(dateKeyToUTC(todayKey) + 86400000).toISOString().slice(0, 10);
  if (dayKey === tomorrowKey) return "Tomorrow";
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

function formatDayDate(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

function formatTimeRange(startISO, endISO, timezone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  const start = fmt.format(new Date(startISO));
  if (!endISO) return start;
  const end = fmt.format(new Date(endISO));
  return `${start}–${end}`;
}

function base64url(input) {
  const base64 =
    typeof input === "string" ? btoa(input) : btoa(String.fromCharCode(...new Uint8Array(input)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
