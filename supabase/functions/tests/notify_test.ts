import { assert, assertEquals, assertFalse, assertMatch, assertNotEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { type AlarmResult, buildFallback } from "../malabar-alarm/alarm.ts";
import { buildDetails, buildEmail, formatDelay, isoInZone, NotificationError, ResendEmailClient, shouldSend } from "../malabar-alarm/notify.ts";
import { FAKE_EMAIL, FAKE_RESEND_KEY, FakeFetch, ist, noSleep, raw, SENT, settings, status, timeoutError, TZ } from "./helpers.ts";

const DAY = "2026-11-12";
const NOW = ist(2026, 11, 12, 3, 47);

const live = (o: Partial<AlarmResult> = {}): AlarmResult => ({
  status: "LIVE",
  journeyDate: DAY,
  arrival: ist(2026, 11, 12, 5, 14),
  wakeup: ist(2026, 11, 12, 4, 34),
  bufferMinutes: 40,
  delayMinutes: 23,
  provenance: "predicted",
  reason: null,
  ...o,
});

const client = (f: FakeFetch, maxAttempts = 3) =>
  new ResendEmailClient(FAKE_RESEND_KEY, "Malabar Smart Alarm <onboarding@resend.dev>", FAKE_EMAIL, { fetchFn: f.fn, sleep: noSleep, maxAttempts });

// --- Email content (machine-readable for iPhone Shortcuts) ------------------

Deno.test("LIVE email: subject carries HH:MM for the Shortcut", () => {
  const e = buildEmail(live(), settings(), NOW);
  assertEquals(e.subject, "Malabar Alarm 04:34 | LIVE | Thu 12 Nov 2026");
  // The Shortcut extracts the FIRST HH:MM in the subject - it must be the wake-up time.
  assertEquals(e.subject.match(/\d{2}:\d{2}/)?.[0], "04:34");
  const lines = e.text.split("\n");
  assertEquals(lines[0], "WAKEUP=04:34");
  assertEquals(lines[1], "WAKEUP_ISO=2026-11-12T04:34:00+05:30");
  assertEquals(lines[2], "STATUS=LIVE");
  for (const l of ["Train: Malabar Express (16630)", "Boarding: Chengannur (CNGR)", "Predicted arrival: 05:14 AM", "Recommended wake-up: 04:34 AM", "Delay: 23 minutes", "Status: LIVE"]) {
    assert(lines.includes(l), l);
  }
  assertEquals(e.idempotencyKey, "malabar-16630-2026-11-12-LIVE");
});

Deno.test("FALLBACK email clearly labelled, wake-up 04:11", () => {
  const e = buildEmail(buildFallback(settings(), DAY, "RailRadar API unavailable: timed out"), settings(), NOW);
  assertEquals(e.subject, "Malabar Alarm 04:11 | FALLBACK | Thu 12 Nov 2026");
  assertStringIncludes(e.text, "WAKEUP=04:11");
  assertStringIncludes(e.text, "NOT live");
  assertStringIncludes(e.text, "Reason: RailRadar API unavailable");
  assertFalse(e.text.includes("Predicted arrival"));
});

Deno.test("SCHEDULED email labelled", () => {
  const e = buildEmail(live({ status: "SCHEDULED", arrival: ist(2026, 11, 12, 4, 51), wakeup: ist(2026, 11, 12, 4, 11), reason: "No live prediction" }), settings(), NOW);
  assertStringIncludes(e.subject, "| SCHEDULED |");
  assertStringIncludes(e.text, "Scheduled arrival: 04:51 AM (no live prediction)");
});

Deno.test("manual email marked TEST with unique idempotency key", () => {
  const a = buildEmail(live(), settings(), NOW, true);
  const b = buildEmail(live(), settings(), NOW, true);
  assert(a.subject.endsWith("| TEST"));
  assertStringIncludes(a.text, "(Manual test run)");
  assertMatch(a.idempotencyKey, /^malabar-manual-/);
  assertNotEquals(a.idempotencyKey, b.idempotencyKey);
});

Deno.test("custom subject prefix and wake-up already passed note", () => {
  const e = buildEmail(live(), settings({ emailSubjectPrefix: "Train Wake" }), ist(2026, 11, 12, 4, 40));
  assert(e.subject.startsWith("Train Wake 04:34"));
  assertStringIncludes(e.text, "already passed");
});

Deno.test("PM times and ISO in other zones", () => {
  const d = buildDetails(live({ arrival: ist(2026, 11, 12, 13, 5), wakeup: ist(2026, 11, 12, 12, 25) }), settings(), NOW);
  assert(d.includes("Predicted arrival: 01:05 PM"));
  assert(d.includes("Recommended wake-up: 12:25 PM"));
  assertEquals(isoInZone(new Date("2026-11-11T23:04:00Z"), TZ), "2026-11-12T04:34:00+05:30");
  assertEquals(isoInZone(new Date("2026-11-11T23:04:00Z"), "UTC"), "2026-11-11T23:04:00+00:00");
});

Deno.test("formatDelay", () => {
  assertEquals(formatDelay(null), "not available");
  assertEquals(formatDelay(0), "on time");
  assertEquals(formatDelay(1), "1 minute");
  assertEquals(formatDelay(-5), "running 5 minutes early");
});

Deno.test("shouldSend rules", () => {
  assert(shouldSend(new Set(), "LIVE").send);
  assertFalse(shouldSend(new Set(["LIVE"]), "LIVE").send);
  const up = shouldSend(new Set(["FALLBACK"]), "LIVE");
  assert(up.send);
  assertStringIncludes(up.why, "upgrading");
  assertFalse(shouldSend(new Set(["FALLBACK"]), "FALLBACK").send);
  assertFalse(shouldSend(new Set(["LIVE"]), "FALLBACK").send);
  assertFalse(shouldSend(new Set(["SCHEDULED"]), "SCHEDULED").send);
});

// --- Resend client ----------------------------------------------------------

Deno.test("send posts correct request to Resend", async () => {
  const f = new FakeFetch({ "api.resend.com": [SENT] });
  const e = buildEmail(live(), settings(), NOW);
  assertEquals(await client(f).send(e), "email-1");
  const c = f.calls[0];
  assertEquals(c.url, "https://api.resend.com/emails");
  assertEquals(c.method, "POST");
  assertEquals(c.headers.get("Authorization"), `Bearer ${FAKE_RESEND_KEY}`);
  assertEquals(c.headers.get("Idempotency-Key"), "malabar-16630-2026-11-12-LIVE");
  const body = JSON.parse(c.body!);
  assertEquals(body.from, "Malabar Smart Alarm <onboarding@resend.dev>");
  assertEquals(body.to, [FAKE_EMAIL]);
  assertEquals(body.subject, e.subject);
  assertEquals(body.text, e.text);
});

Deno.test("provider error message is reported, key never leaked", async () => {
  const msg = { statusCode: 403, name: "validation_error", message: `You can only send testing emails to your own email address. key ${FAKE_RESEND_KEY}` };
  const f = new FakeFetch({ "api.resend.com": [new Response(JSON.stringify(msg), { status: 403 })] });
  const err = await assertRejects(() => client(f).send(buildEmail(live(), settings(), NOW)), NotificationError);
  assertStringIncludes(err.message, "HTTP 403: You can only send testing emails");
  assertFalse(err.message.includes(FAKE_RESEND_KEY));
  assertEquals(f.calls.length, 1); // 4xx not retried
});

Deno.test("5xx and 429 retried, then reported", async () => {
  const f = new FakeFetch({ "api.resend.com": [status(500), status(429), status(503)] });
  await assertRejects(() => client(f).send(buildEmail(live(), settings(), NOW)), NotificationError, "HTTP 503");
  assertEquals(f.calls.length, 3);
});

Deno.test("recovers after a transient error", async () => {
  const f = new FakeFetch({ "api.resend.com": [status(502), SENT] });
  assertEquals(await client(f).send(buildEmail(live(), settings(), NOW)), "email-1");
});

Deno.test("timeout", async () => {
  const f = new FakeFetch({ "api.resend.com": [timeoutError(), timeoutError(), timeoutError()] });
  await assertRejects(() => client(f).send(buildEmail(live(), settings(), NOW)), NotificationError, "timed out");
});

Deno.test("unconfirmed send is a failure", async () => {
  await assertRejects(() => client(new FakeFetch({ "api.resend.com": [raw("ok")] })).send(buildEmail(live(), settings(), NOW)), NotificationError);
  await assertRejects(() => client(new FakeFetch({ "api.resend.com": [{}] })).send(buildEmail(live(), settings(), NOW)), NotificationError);
});

Deno.test("client rejects bad config and hides key", () => {
  assertThrows(() => new ResendEmailClient("", "a <b@c.d>", FAKE_EMAIL), NotificationError, "RESEND_API_KEY");
  assertThrows(() => new ResendEmailClient(FAKE_RESEND_KEY, "a <b@c.d>", "not-an-email"), NotificationError, "ALARM_EMAIL_TO");
  assertThrows(() => new ResendEmailClient(FAKE_RESEND_KEY, "a <b@c.d>", FAKE_EMAIL, { endpoint: "http://x" }), NotificationError);
  assertFalse(String(new ResendEmailClient(FAKE_RESEND_KEY, "a <b@c.d>", FAKE_EMAIL)).includes(FAKE_RESEND_KEY));
});
