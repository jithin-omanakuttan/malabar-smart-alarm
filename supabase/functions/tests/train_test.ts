import { assert, assertEquals, assertFalse, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { RailRadarClient, RailRadarError } from "../malabar-alarm/railradar.ts";
import { extractSnapshot, InvalidTimestampError, parseTimestamp, TrainDataError } from "../malabar-alarm/train.ts";
import { cngr, FAKE_API_KEY, FakeFetch, ist, loadFixture, noSleep, raw, status, timeoutError, TZ } from "./helpers.ts";

const URL = "https://api.railradar.in/v1/trains/16630/live";
const client = (f: FakeFetch, maxAttempts = 2) =>
  new RailRadarClient(FAKE_API_KEY, { fetchFn: f.fn, sleep: noSleep, maxAttempts });

// --- API client -----------------------------------------------------------

Deno.test("successful API response with Bearer auth", async () => {
  const f = new FakeFetch({ railradar: [loadFixture()] });
  const payload = await client(f).fetchLive("16630");
  assertEquals(payload.success, true);
  assertEquals(f.calls[0].url, URL);
  assertEquals(f.calls[0].method, "GET");
  assertEquals(f.calls[0].headers.get("Authorization"), `Bearer ${FAKE_API_KEY}`);
});

Deno.test("network timeout is retried then reported", async () => {
  const f = new FakeFetch({ railradar: [timeoutError(), timeoutError()] });
  const err = await assertRejects(() => client(f).fetchLive("16630"), RailRadarError);
  assertStringIncludes(err.message, "timed out");
  assertEquals(f.calls.length, 2);
});

Deno.test("generic network error is reported without URL", async () => {
  const f = new FakeFetch({ railradar: [new TypeError("dns failure for api.railradar.in")] });
  const err = await assertRejects(() => client(f, 1).fetchLive("16630"), RailRadarError);
  assertStringIncludes(err.message, "network error (TypeError)");
});

Deno.test("recovers after transient 503", async () => {
  const f = new FakeFetch({ railradar: [status(503), loadFixture()] });
  assertEquals((await client(f).fetchLive("16630")).success, true);
});

Deno.test("401 not retried and key never leaked", async () => {
  const f = new FakeFetch({ railradar: [status(401)] });
  const c = client(f, 3);
  const err = await assertRejects(() => c.fetchLive("16630"), RailRadarError);
  assertEquals(f.calls.length, 1);
  assertStringIncludes(err.message, "401");
  assertFalse(err.message.includes(FAKE_API_KEY));
  assertFalse(String(c).includes(FAKE_API_KEY));
});

Deno.test("invalid JSON", async () => {
  const err = await assertRejects(() => client(new FakeFetch({ railradar: [raw("<html>oops</html>")] })).fetchLive("16630"), RailRadarError);
  assertStringIncludes(err.message, "invalid JSON");
});

Deno.test("JSON that is not an object", async () => {
  await assertRejects(() => client(new FakeFetch({ railradar: [[1, 2, 3]] })).fetchLive("16630"), RailRadarError);
});

Deno.test("client requires key, HTTPS and numeric train", () => {
  assertThrows(() => new RailRadarClient(""), RailRadarError);
  assertThrows(() => new RailRadarClient(FAKE_API_KEY, { baseUrl: "http://api.railradar.in/v1" }), RailRadarError);
  assertThrows(() => new RailRadarClient(FAKE_API_KEY).liveUrl("16630/../x"), RailRadarError);
});

// --- Response validation / station extraction ----------------------------

Deno.test("extracts Chengannur (CNGR)", () => {
  const s = extractSnapshot(loadFixture(), "16630", "CNGR", TZ);
  assertEquals(s.trainNumber, "16630");
  assertEquals(s.delayMinutes, 23);
  assertEquals(s.station.stationCode, "CNGR");
  assertEquals(s.station.stationName, "Chengannur");
  assertEquals(s.station.status, "upcoming");
  assertEquals(s.station.provenance, "predicted");
  assertEquals(s.station.scheduledArrival, ist(2026, 11, 12, 4, 51));
  assertEquals(s.station.actualArrival, ist(2026, 11, 12, 5, 14));
  assertEquals(s.station.invalidFields, []);
});

Deno.test("station code is case-insensitive", () => {
  assertEquals(extractSnapshot(loadFixture(), "16630", "cngr", TZ).station.stationCode, "CNGR");
});

Deno.test("missing Chengannur station", () => {
  const p = loadFixture();
  // deno-lint-ignore no-explicit-any
  p.data.route = p.data.route.filter((r: any) => r.stationCode !== "CNGR");
  assertThrows(() => extractSnapshot(p, "16630", "CNGR", TZ), TrainDataError, "CNGR not found");
});

Deno.test("missing predicted arrival fields become null", () => {
  const p = loadFixture();
  delete cngr(p).actualArrival;
  cngr(p).scheduledArrival = "";
  const s = extractSnapshot(p, "16630", "CNGR", TZ);
  assertEquals(s.station.actualArrival, null);
  assertEquals(s.station.scheduledArrival, null);
});

Deno.test("invalid timestamp is recorded, not fatal", () => {
  const p = loadFixture();
  cngr(p).actualArrival = 12345;
  const s = extractSnapshot(p, "16630", "CNGR", TZ);
  assertEquals(s.station.actualArrival, null);
  assertEquals(s.station.invalidFields, ["actualArrival"]);
});

Deno.test("invalid API responses", () => {
  const cases: Record<string, unknown> = {
    "not an object": [],
    "null": null,
    "success false": { success: false, data: {} },
    "no data": { success: true },
    "no train number": { success: true, data: { train: {}, route: [{}] } },
    "empty route": { success: true, data: { train: { number: "16630" }, route: [] } },
  };
  for (const [name, payload] of Object.entries(cases)) {
    assertThrows(() => extractSnapshot(payload, "16630", "CNGR", TZ), TrainDataError, undefined, name);
  }
});

Deno.test("wrong train number rejected; numeric number accepted", () => {
  const p = loadFixture();
  p.data.train.number = 16629;
  assertThrows(() => extractSnapshot(p, "16630", "CNGR", TZ), TrainDataError, "16629");
  p.data.train.number = 16630;
  assertEquals(extractSnapshot(p, "16630", "CNGR", TZ).trainNumber, "16630");
});

Deno.test("null delay", () => {
  const p = loadFixture();
  p.data.delayMinutes = null;
  assertEquals(extractSnapshot(p, "16630", "CNGR", TZ).delayMinutes, null);
});

// --- Timestamp parsing / IST conversion -----------------------------------

Deno.test("timestamp parsing and IST conversion", () => {
  assertEquals(parseTimestamp("2026-11-12T05:14:00+05:30", TZ), ist(2026, 11, 12, 5, 14));
  assertEquals(parseTimestamp("2026-11-11T23:44:00Z", TZ), ist(2026, 11, 12, 5, 14));
  assertEquals(parseTimestamp("2026-11-11T23:44:00.000Z", TZ), ist(2026, 11, 12, 5, 14));
  assertEquals(parseTimestamp("2026-11-12T05:14:00", TZ), ist(2026, 11, 12, 5, 14)); // naive = IST
  assertEquals(parseTimestamp("2026-11-12T05:14:00+0530", TZ), ist(2026, 11, 12, 5, 14));
  assertEquals(parseTimestamp(null, TZ), null);
  assertEquals(parseTimestamp("  ", TZ), null);
  for (const bad of ["tomorrow", "2026-13-40T00:00:00", "2026-02-30T05:00:00+05:30", 5]) {
    assertThrows(() => parseTimestamp(bad, TZ), InvalidTimestampError);
  }
  assert(true);
});
