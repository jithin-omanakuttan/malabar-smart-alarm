import { assert, assertEquals, assertFalse, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { type AlarmResult, buildFallback } from "../malabar-alarm/alarm.ts";
import { buildMessage, encodeHeader, formatDelay, NotificationError, NtfyClient, shouldSend } from "../malabar-alarm/notify.ts";
import { FAKE_TOPIC, FakeFetch, ist, noSleep, PUBLISHED, raw, settings, status, timeoutError } from "./helpers.ts";

const DAY = "2026-11-12";
const NOW = ist(2026, 11, 12, 4, 0);

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

const ntfy = (f: FakeFetch, token = "") => new NtfyClient("https://ntfy.sh", FAKE_TOPIC, { token, fetchFn: f.fn, sleep: noSleep });

Deno.test("LIVE notification payload", () => {
  const msg = buildMessage(live(), settings(), NOW);
  assertEquals(msg.title, "Malabar Smart Alarm");
  assertEquals(msg.priority, 5);
  const lines = msg.body.split("\n");
  assertEquals(lines[0], "Train: Malabar Express (16630)");
  assertEquals(lines[1], "Boarding: Chengannur (CNGR)");
  assertEquals(lines[2], "Date: Thu 12 Nov 2026");
  for (const l of ["Predicted arrival: 05:14 AM", "Recommended wake-up: 04:34 AM", "Delay: 23 minutes", "Status: LIVE"]) {
    assert(lines.includes(l), l);
  }
  assertFalse(msg.body.includes("passed"));
  assertFalse(msg.body.includes("Manual"));
});

Deno.test("FALLBACK clearly labelled", () => {
  const r = buildFallback(settings(), DAY, "RailRadar API unavailable: timed out");
  const msg = buildMessage(r, settings(), NOW);
  assertStringIncludes(msg.title, "FALLBACK");
  assertStringIncludes(msg.body, "Status: FALLBACK");
  assertStringIncludes(msg.body, "NOT live");
  assertStringIncludes(msg.body, "Recommended wake-up: 04:11 AM");
  assertStringIncludes(msg.body, "Reason: RailRadar API unavailable");
  assertFalse(msg.body.includes("Predicted arrival"));
  assert(msg.tags.includes("warning"));
});

Deno.test("SCHEDULED labelled", () => {
  const r = live({ status: "SCHEDULED", arrival: ist(2026, 11, 12, 4, 51), wakeup: ist(2026, 11, 12, 4, 11), reason: "No live prediction" });
  const msg = buildMessage(r, settings(), NOW);
  assertStringIncludes(msg.body, "Scheduled arrival: 04:51 AM (no live prediction)");
  assertStringIncludes(msg.title, "SCHEDULED");
});

Deno.test("wake-up already passed note; manual marker", () => {
  assertStringIncludes(buildMessage(live(), settings(), ist(2026, 11, 12, 4, 40)).body, "already passed");
  assertStringIncludes(buildMessage(live(), settings(), NOW, true).body, "(Manual test run)");
});

Deno.test("PM times format correctly", () => {
  const msg = buildMessage(live({ arrival: ist(2026, 11, 12, 13, 5), wakeup: ist(2026, 11, 12, 12, 25) }), settings(), NOW);
  assertStringIncludes(msg.body, "Predicted arrival: 01:05 PM");
  assertStringIncludes(msg.body, "Recommended wake-up: 12:25 PM");
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

Deno.test("publish sends correct headers and body", async () => {
  const f = new FakeFetch({ "ntfy.sh": [PUBLISHED] });
  const msg = buildMessage(live(), settings(), NOW);
  assertEquals(await ntfy(f, "tk_test").publish(msg), "m1");
  const c = f.calls[0];
  assertEquals(c.url, `https://ntfy.sh/${FAKE_TOPIC}`);
  assertEquals(c.method, "POST");
  assertEquals(c.headers.get("Title"), "Malabar Smart Alarm");
  assertEquals(c.headers.get("Priority"), "5");
  assertEquals(c.headers.get("Tags"), "steam_locomotive,alarm_clock");
  assertEquals(c.headers.get("Authorization"), "Bearer tk_test");
  assertEquals(c.body, msg.body);
});

Deno.test("publish 5xx retried, failure reported without topic", async () => {
  const f = new FakeFetch({ "ntfy.sh": [status(500), status(502), status(503)] });
  const err = await assertRejects(() => ntfy(f).publish(buildMessage(live(), settings(), NOW)), NotificationError);
  assertEquals(f.calls.length, 3);
  assertFalse(err.message.includes(FAKE_TOPIC));
});

Deno.test("publish 4xx not retried", async () => {
  const f = new FakeFetch({ "ntfy.sh": [status(403)] });
  await assertRejects(() => ntfy(f).publish(buildMessage(live(), settings(), NOW)), NotificationError);
  assertEquals(f.calls.length, 1);
});

Deno.test("publish timeout", async () => {
  const f = new FakeFetch({ "ntfy.sh": [timeoutError(), timeoutError(), timeoutError()] });
  await assertRejects(() => ntfy(f).publish(buildMessage(live(), settings(), NOW)), NotificationError, "timed out");
});

Deno.test("unconfirmed publish is a failure", async () => {
  await assertRejects(() => ntfy(new FakeFetch({ "ntfy.sh": [raw("not json")] })).publish(buildMessage(live(), settings(), NOW)), NotificationError);
  await assertRejects(() => ntfy(new FakeFetch({ "ntfy.sh": [{ event: "error" }] })).publish(buildMessage(live(), settings(), NOW)), NotificationError);
});

Deno.test("client rejects bad config and hides topic", () => {
  assertThrows(() => new NtfyClient("https://ntfy.sh", ""), NotificationError);
  assertThrows(() => new NtfyClient("https://ntfy.sh", "bad/topic"), NotificationError);
  assertThrows(() => new NtfyClient("http://ntfy.sh", FAKE_TOPIC), NotificationError);
  assertFalse(String(new NtfyClient("https://ntfy.sh", FAKE_TOPIC)).includes(FAKE_TOPIC));
});

Deno.test("non-ASCII titles are RFC 2047 encoded", () => {
  assertEquals(encodeHeader("Plain"), "Plain");
  assert(encodeHeader("അലാറം").startsWith("=?UTF-8?B?"));
});
