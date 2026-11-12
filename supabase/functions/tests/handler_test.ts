import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { ConfigError, loadConfig, parseWeekdays } from "../malabar-alarm/config.ts";
import { handleRequest, isMonitoringDay, journeyDateFor, serviceKeyFrom } from "../malabar-alarm/handler.ts";
import { MemoryLogger } from "../malabar-alarm/log.ts";
import { PostgrestStore } from "../malabar-alarm/store.ts";
import { buildFallback } from "../malabar-alarm/alarm.ts";
import {
  FAKE_API_KEY, FAKE_EMAIL, FAKE_RESEND_KEY, FAKE_TRIGGER, FakeFetch, ist, loadFixture, MemoryStore, noSleep, SENT, settings, status,
  timeoutError, utc,
} from "./helpers.ts";

const ENV = {
  ALARM_TRIGGER_SECRET: FAKE_TRIGGER,
  RAILRADAR_API_KEY: FAKE_API_KEY,
  RESEND_API_KEY: FAKE_RESEND_KEY,
  ALARM_EMAIL_TO: FAKE_EMAIL,
};
const THURSDAY_4AM = ist(2026, 11, 12, 4, 0);

function req(body: unknown = {}, secret = FAKE_TRIGGER, method = "POST"): Request {
  return new Request("https://example.supabase.co/functions/v1/malabar-alarm", {
    method,
    headers: { "x-alarm-secret": secret, "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

async function call(
  opts: { body?: unknown; env?: Record<string, string>; fetch?: FakeFetch; store?: MemoryStore | null; now?: Date; secret?: string } = {},
) {
  const log = new MemoryLogger();
  const res = await handleRequest(req(opts.body ?? {}, opts.secret ?? FAKE_TRIGGER), { ...ENV, ...(opts.env ?? {}) }, {
    fetchFn: (opts.fetch ?? new FakeFetch({})).fn,
    sleep: noSleep,
    log,
    now: () => opts.now ?? THURSDAY_4AM,
    store: opts.store === undefined ? new MemoryStore() : opts.store,
  });
  return { res, body: await res.json(), log };
}

// --- Scheduling ------------------------------------------------------------

Deno.test("IST weekday rollover from UTC", () => {
  const s = settings();
  // Sunday 22:30 UTC == Monday 04:00 IST
  assertEquals(utc(2026, 11, 8, 22, 30).getUTCDay(), 0);
  assert(isMonitoringDay(utc(2026, 11, 8, 22, 30), s));
  // Friday 22:30 UTC == Saturday 04:00 IST
  assertFalse(isMonitoringDay(utc(2026, 11, 13, 22, 30), s));
  // Thursday 22:30 UTC == Friday 04:00 IST
  assert(isMonitoringDay(utc(2026, 11, 12, 22, 30), s));
});

Deno.test("Monday to Friday only", () => {
  const got = [0, 1, 2, 3, 4, 5, 6].map((i) => isMonitoringDay(ist(2026, 11, 9 + i, 4, 0), settings()));
  assertEquals(got, [true, true, true, true, true, false, false]);
});

Deno.test("journey date: pre-dawn = today; evening manual run = tomorrow", () => {
  assertEquals(journeyDateFor(ist(2026, 11, 12, 3, 47), settings()), "2026-11-12");
  assertEquals(journeyDateFor(utc(2026, 11, 11, 22, 30), settings()), "2026-11-12");
  assertEquals(journeyDateFor(ist(2026, 11, 11, 21, 0), settings()), "2026-11-12");
});

Deno.test("cron migration schedules 03:47/03:53/04:00 IST Mon-Fri in UTC", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261111180000_malabar_alarm.sql", import.meta.url));
  assertStringIncludes(sql, "'17,23,30 22 * * 0-4'");
  // Each cron firing (UTC Sun-Thu 22:17/22:23/22:30) maps to IST Mon-Fri 03:47/03:53/04:00
  const expected = ["03:47", "03:53", "04:00"];
  for (let day = 8; day <= 12; day++) { // Sun 8 Nov .. Thu 12 Nov 2026 (UTC)
    [17, 23, 30].forEach((minute, i) => {
      const fire = utc(2026, 11, day, 22, minute);
      assert(isMonitoringDay(fire, settings()));
      const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }).format(fire);
      assertEquals(p, expected[i]);
    });
  }
  assertFalse(sql.includes("sb_secret_"));
  assertStringIncludes(sql, "vault.decrypted_secrets");
});

// --- HTTP / auth -----------------------------------------------------------

Deno.test("rejects missing or wrong trigger secret", async () => {
  const { res } = await call({ secret: "wrong" });
  assertEquals(res.status, 401);
  const noSecret = await handleRequest(req({}), { ...ENV, ALARM_TRIGGER_SECRET: "" }, { log: new MemoryLogger() });
  assertEquals(noSecret.status, 500);
  const put = await handleRequest(req({}, FAKE_TRIGGER, "PUT"), ENV, { log: new MemoryLogger() });
  assertEquals(put.status, 405);
});

Deno.test("rejects non-JSON body", async () => {
  const r = new Request("https://x/functions/v1/malabar-alarm", { method: "POST", headers: { "x-alarm-secret": FAKE_TRIGGER }, body: "{oops" });
  assertEquals((await handleRequest(r, ENV, { log: new MemoryLogger() })).status, 400);
});

// --- End to end ------------------------------------------------------------

Deno.test("LIVE end to end; secrets never logged or returned", async () => {
  const fetch = new FakeFetch({ railradar: [loadFixture()], "api.resend.com": [SENT] });
  const store = new MemoryStore();
  const { res, body, log } = await call({ fetch, store });
  assertEquals(res.status, 200);
  assertEquals(body.outcome, "sent");
  assertEquals(body.status, "LIVE");
  assertEquals(body.wakeup, "04:34");
  const sent = fetch.callsTo("api.resend.com")[0].body!;
  const mail = JSON.parse(sent);
  assertEquals(mail.subject, "Malabar Alarm 04:34 | LIVE | Thu 12 Nov 2026");
  assertStringIncludes(mail.text, "Predicted arrival: 05:14 AM");
  assertStringIncludes(mail.text, "WAKEUP=04:34");
  assertEquals(store.records.map((r) => r.outcome), ["sent"]);
  assertEquals(store.records[0].messageId, "email-1");
  assertEquals(body.messageId, "email-1");
  const everything = log.lines.join("\n") + JSON.stringify(body);
  for (const secret of [FAKE_API_KEY, FAKE_RESEND_KEY, FAKE_TRIGGER]) assertFalse(everything.includes(secret), secret);
});

Deno.test("API timeout sends FALLBACK", async () => {
  const fetch = new FakeFetch({ railradar: [timeoutError(), timeoutError()], "api.resend.com": [SENT] });
  const { body } = await call({ fetch });
  assertEquals(body.status, "FALLBACK");
  assertEquals(body.wakeup, "04:11");
  assertStringIncludes(JSON.parse(fetch.callsTo("api.resend.com")[0].body!).subject, "04:11 | FALLBACK");
});

Deno.test("duplicate LIVE is skipped and logged", async () => {
  const fetch = new FakeFetch({ railradar: [loadFixture()] });
  const store = new MemoryStore(new Set(["LIVE"]));
  const { body } = await call({ fetch, store });
  assertEquals(body.outcome, "skipped");
  assertEquals(fetch.callsTo("api.resend.com").length, 0);
  assertEquals(store.records.map((r) => r.outcome), ["skipped"]);
});

Deno.test("earlier FALLBACK is upgraded to LIVE", async () => {
  const fetch = new FakeFetch({ railradar: [loadFixture()], "api.resend.com": [SENT] });
  const { body } = await call({ fetch, store: new MemoryStore(new Set(["FALLBACK"])) });
  assertEquals(body.outcome, "sent");
});

Deno.test("run-log outage still sends (no missed alarm)", async () => {
  const fetch = new FakeFetch({ railradar: [loadFixture()], "api.resend.com": [SENT] });
  const { body, log } = await call({ fetch, store: new MemoryStore(new Set(), true) });
  assertEquals(body.outcome, "sent");
  assert(log.lines.some((l) => l.includes("Duplicate check unavailable")));
});

Deno.test("delivery failure returns 502 and is recorded", async () => {
  const fetch = new FakeFetch({ railradar: [loadFixture()], "api.resend.com": [status(500), status(500), status(500)] });
  const store = new MemoryStore();
  const { res, body } = await call({ fetch, store });
  assertEquals(res.status, 502);
  assertEquals(body.outcome, "delivery_failed");
  assertStringIncludes(body.detail, "NOT delivered");
  assertEquals(store.records.map((r) => r.outcome), ["delivery_failed"]);
});

Deno.test("weekend: nothing happens unless forced", async () => {
  const saturday = ist(2026, 11, 14, 4, 0);
  const idle = new FakeFetch({});
  const { body } = await call({ fetch: idle, now: saturday });
  assertEquals(body.outcome, "not_monitoring_day");
  assertEquals(idle.calls.length, 0);

  const fetch = new FakeFetch({ railradar: [loadFixture()], "api.resend.com": [SENT] });
  const store = new MemoryStore(new Set(["LIVE"])); // manual runs ignore duplicates
  const forced = await call({ fetch, now: saturday, store, body: { force: true } });
  assertEquals(forced.body.outcome, "sent");
  assert(store.records[0].manual);
  assertStringIncludes(JSON.parse(fetch.callsTo("api.resend.com")[0].body!).subject, "| TEST");
});

Deno.test("dry run sends nothing and returns the message", async () => {
  const fetch = new FakeFetch({ railradar: [loadFixture()] });
  const { body } = await call({ fetch, body: { force: true, dry_run: true }, env: { RESEND_API_KEY: "" } });
  assertEquals(body.outcome, "dry_run");
  assertStringIncludes(body.email.text, "WAKEUP=04:34");
  assertEquals(fetch.callsTo("api.resend.com").length, 0);
});

Deno.test("missing email settings are config errors", async () => {
  assertEquals((await call({ env: { RESEND_API_KEY: "" } })).res.status, 500);
  assertEquals((await call({ env: { ALARM_EMAIL_TO: "" } })).res.status, 500);
  assertEquals((await call({ env: { ALARM_EMAIL_TO: "nope" } })).res.status, 500);
});

Deno.test("missing API key sends FALLBACK with warning", async () => {
  const fetch = new FakeFetch({ "api.resend.com": [SENT] });
  const { body } = await call({ fetch, env: { RAILRADAR_API_KEY: "" } });
  assertEquals(body.status, "FALLBACK");
  assertStringIncludes(body.warning, "RAILRADAR_API_KEY");
});

// --- Run log (PostgREST) ---------------------------------------------------

Deno.test("PostgrestStore queries and inserts with service key", async () => {
  const fetch = new FakeFetch({ "rest/v1/alarm_runs?": [[{ status: "FALLBACK" }]], "rest/v1/alarm_runs": [new Response(null, { status: 201 })] });
  const store = new PostgrestStore("https://abc.supabase.co", "eyJ.legacy.jwt", fetch.fn);
  assertEquals([...await store.sentStatuses("16630", "2026-11-12")], ["FALLBACK"]);
  const q = fetch.calls[0];
  assertStringIncludes(q.url, "train_number=eq.16630");
  assertStringIncludes(q.url, "journey_date=eq.2026-11-12");
  assertStringIncludes(q.url, "outcome=eq.sent");
  assertStringIncludes(q.url, "manual=is.false");
  assertEquals(q.headers.get("Authorization"), "Bearer eyJ.legacy.jwt");

  await store.record({ outcome: "sent", manual: false, trainNumber: "16630", result: buildFallback(settings(), "2026-11-12", "x"), detail: "d" });
  const row = JSON.parse(fetch.calls[1].body!);
  assertEquals(row.status, "FALLBACK");
  assertEquals(row.journey_date, "2026-11-12");
  assertEquals(row.wakeup, "2026-11-11T22:41:00.000Z");
});

Deno.test("new sb_secret_ keys go only in apikey header", async () => {
  const fetch = new FakeFetch({ "alarm_runs": [[]] });
  await new PostgrestStore("https://abc.supabase.co", "sb_secret_abc", fetch.fn).sentStatuses("16630", "2026-11-12");
  assertEquals(fetch.calls[0].headers.get("apikey"), "sb_secret_abc");
  assertEquals(fetch.calls[0].headers.get("Authorization"), null);
});

Deno.test("service key discovery", () => {
  assertEquals(serviceKeyFrom({ SUPABASE_SERVICE_ROLE_KEY: "legacy" }), "legacy");
  assertEquals(serviceKeyFrom({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}' }), "sb_secret_x");
  assertEquals(serviceKeyFrom({}), "");
});

// --- Config ----------------------------------------------------------------

Deno.test("config defaults and overrides", () => {
  const d = loadConfig({}).settings;
  assertEquals([d.trainNumber, d.boardingStationCode, d.bufferMinutes, d.timezone], ["16630", "CNGR", 40, "Asia/Kolkata"]);
  const o = loadConfig({ BUFFER_MINUTES: "30", BOARDING_STATION_CODE: "ktym", MONITORING_DAYS: "MON-WED,SAT", FALLBACK_SCHEDULED_ARRIVAL: "03:30", BUFFER_X: "" }).settings;
  assertEquals(o.bufferMinutes, 30);
  assertEquals(o.boardingStationCode, "KTYM");
  assertEquals([...o.monitoringWeekdays].sort(), [0, 1, 2, 5]);
  assertEquals(o.fallbackScheduledArrival, { hour: 3, minute: 30 });
  assertEquals(loadConfig({ BUFFER_MINUTES: "  " }).settings.bufferMinutes, 40);
});

Deno.test("config rejects invalid values", () => {
  for (const env of [
    { BUFFER_MINUTES: "abc" }, { BUFFER_MINUTES: "500" }, { TRAIN_NUMBER: "16x30" }, { TIMEZONE: "Mars/Base" },
    { FALLBACK_SCHEDULED_ARRIVAL: "4.51" }, { MONITORING_DAYS: "FUNDAY" }, { EMAIL_SUBJECT_PREFIX: "Wake 04:00" },
  ]) assertThrows(() => loadConfig(env), ConfigError, undefined, JSON.stringify(env));
  assertThrows(() => parseWeekdays("FRI-MON"), ConfigError);
});

// --- GET: latest wake-up for the iPhone Shortcut -----------------------------

async function getLatest(store: MemoryStore, query = "", secret = FAKE_TRIGGER) {
  const r = new Request(`https://x/functions/v1/malabar-alarm${query}`, { method: "GET", headers: { "x-alarm-secret": secret } });
  return await handleRequest(r, ENV, { log: new MemoryLogger(), store, now: () => ist(2026, 11, 12, 3, 50) });
}

Deno.test("GET returns latest emailed wake-up (JSON and text)", async () => {
  const store = new MemoryStore();
  store.latest = { status: "LIVE", wakeup: "2026-11-11T23:04:00Z", arrival: "2026-11-11T23:44:00Z", manual: false, createdAt: "2026-11-11T22:17:05Z" };
  const res = await getLatest(store);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals([body.wakeup, body.arrival, body.status, body.journeyDate], ["04:34", "05:14", "LIVE", "2026-11-12"]);
  const text = await getLatest(store, "?format=text");
  assertEquals(await text.text(), "04:34");
});

Deno.test("GET with nothing sent yet returns 404; wrong secret 401", async () => {
  assertEquals((await getLatest(new MemoryStore())).status, 404);
  const t = await getLatest(new MemoryStore(), "?format=text");
  assertEquals([t.status, await t.text()], [404, "NONE"]);
  assertEquals((await getLatest(new MemoryStore(), "", "wrong")).status, 401);
});

Deno.test("PostgrestStore.latestSent queries newest sent row", async () => {
  const fetch = new FakeFetch({ "alarm_runs": [[{ status: "LIVE", wakeup: "2026-11-11T23:04:00+00:00", arrival: "2026-11-11T23:44:00+00:00", manual: true, created_at: "x" }]] });
  const latest = await new PostgrestStore("https://abc.supabase.co", "eyJ.k", fetch.fn).latestSent("16630", "2026-11-12");
  assertEquals(latest?.status, "LIVE");
  assertEquals(latest?.manual, true);
  assertStringIncludes(fetch.calls[0].url, "order=created_at.desc");
  assertStringIncludes(fetch.calls[0].url, "limit=1");
  assertStringIncludes(fetch.calls[0].url, "outcome=eq.sent");
});
