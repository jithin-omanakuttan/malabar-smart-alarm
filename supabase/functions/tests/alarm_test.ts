import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { buildFallback, calculateFromSnapshot, calculateWakeup } from "../malabar-alarm/alarm.ts";
import { extractSnapshot } from "../malabar-alarm/train.ts";
import { formatTime12 } from "../malabar-alarm/time.ts";
import { cngr, ist, loadFixture, settings, TZ } from "./helpers.ts";

const DAY = "2026-11-12";
// deno-lint-ignore no-explicit-any
const snap = (payload: any) => extractSnapshot(payload, "16630", "CNGR", TZ);

Deno.test("40-minute buffer: 05:14 -> 04:34", () => {
  assertEquals(calculateWakeup(ist(2026, 11, 12, 5, 14), 40), ist(2026, 11, 12, 4, 34));
});

Deno.test("buffer crossing midnight", () => {
  assertEquals(calculateWakeup(ist(2026, 11, 12, 0, 20), 40), ist(2026, 11, 11, 23, 40));
});

Deno.test("calculateWakeup rejects bad input", () => {
  for (const bad of [-1, 241, 40.5, NaN]) {
    assertThrows(() => calculateWakeup(ist(2026, 11, 12, 5, 14), bad), RangeError);
  }
  assertThrows(() => calculateWakeup(new Date("invalid"), 40), RangeError);
});

Deno.test("LIVE: uses actualArrival (predicted), not departure", () => {
  const r = calculateFromSnapshot(snap(loadFixture()), settings(), DAY);
  assertEquals(r.status, "LIVE");
  assertEquals(r.arrival, ist(2026, 11, 12, 5, 14));
  assertEquals(r.wakeup, ist(2026, 11, 12, 4, 34));
  assertEquals(formatTime12(r.wakeup, TZ), "04:34 AM");
  assertEquals(r.delayMinutes, 23);
  assertEquals(r.provenance, "predicted");
  assertEquals(r.reason, null);
});

Deno.test("SCHEDULED: scheduled arrival used when no prediction", () => {
  const p = loadFixture();
  cngr(p).actualArrival = null;
  const r = calculateFromSnapshot(snap(p), settings(), DAY);
  assertEquals(r.status, "SCHEDULED");
  assertEquals(r.arrival, ist(2026, 11, 12, 4, 51));
  assertEquals(r.wakeup, ist(2026, 11, 12, 4, 11));
  assertStringIncludes(r.reason!, "No live prediction");
});

Deno.test("SCHEDULED: invalid actualArrival is ignored", () => {
  const p = loadFixture();
  cngr(p).actualArrival = "soon";
  const r = calculateFromSnapshot(snap(p), settings(), DAY);
  assertEquals(r.status, "SCHEDULED");
  assertStringIncludes(r.reason!, "not a valid timestamp");
});

Deno.test("FALLBACK: missing both arrival times", () => {
  const p = loadFixture();
  cngr(p).actualArrival = null;
  delete cngr(p).scheduledArrival;
  const r = calculateFromSnapshot(snap(p), settings(), DAY);
  assertEquals(r.status, "FALLBACK");
  assertEquals(r.wakeup, ist(2026, 11, 12, 4, 11));
  assertStringIncludes(r.reason!, "No arrival time");
});

Deno.test("FALLBACK: stale journey (yesterday) is never LIVE", () => {
  const p = loadFixture();
  cngr(p).scheduledArrival = "2026-11-11T04:51:00+05:30";
  cngr(p).actualArrival = "2026-11-11T05:14:00+05:30";
  const r = calculateFromSnapshot(snap(p), settings(), DAY);
  assertEquals(r.status, "FALLBACK");
  assertStringIncludes(r.reason!, "11 Nov 2026");
});

Deno.test("implausible prediction (24h late) is ignored", () => {
  const p = loadFixture();
  cngr(p).actualArrival = "2026-11-13T05:14:00+05:30";
  const r = calculateFromSnapshot(snap(p), settings(), DAY);
  assertEquals(r.status, "SCHEDULED");
  assertStringIncludes(r.reason!, "implausibly");
});

Deno.test("UTC timestamps are converted to IST", () => {
  const p = loadFixture();
  cngr(p).scheduledArrival = "2026-11-11T23:21:00Z";
  cngr(p).actualArrival = "2026-11-11T23:44:00+00:00";
  const r = calculateFromSnapshot(snap(p), settings(), DAY);
  assertEquals(r.status, "LIVE");
  assertEquals(formatTime12(r.arrival, TZ), "05:14 AM");
  assertEquals(formatTime12(r.wakeup, TZ), "04:34 AM");
});

Deno.test("custom buffer", () => {
  const r = calculateFromSnapshot(snap(loadFixture()), settings({ bufferMinutes: 60 }), DAY);
  assertEquals(r.wakeup, ist(2026, 11, 12, 4, 14));
});

Deno.test("default fallback is 04:51 - 40 = 04:11 IST", () => {
  const r = buildFallback(settings(), DAY, "API down");
  assertEquals(r.status, "FALLBACK");
  assertEquals(r.arrival, ist(2026, 11, 12, 4, 51));
  assertEquals(r.wakeup, ist(2026, 11, 12, 4, 11));
  assertEquals(r.wakeup.toISOString(), "2026-11-11T22:41:00.000Z");
  assertEquals(r.reason, "API down");
});

Deno.test("configurable fallback time", () => {
  const r = buildFallback(settings({ fallbackScheduledArrival: { hour: 5, minute: 0 } }), DAY, "x");
  assertEquals(r.wakeup, ist(2026, 11, 12, 4, 20));
  assert(r.wakeup.getUTCHours() === 22);
});
