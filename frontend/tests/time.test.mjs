// Server timestamps are UTC ("...Z"); the UI must show them in the viewer's
// local time zone. Runs the real formatters in a UTC+5:30 (India) zone.
//   node --test frontend/tests/time.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TZ = "Asia/Kolkata";                       // UTC+5:30, no daylight saving
// Just enough of a browser for the modules to load (motion.js and ui.js touch these on load).
globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.document = { addEventListener() {} };
const { fmt } = await import("../js/ui.js");

test("the browser is in UTC+5:30 for these checks", () => {
  assert.equal(new Date("2026-10-07T00:00:00Z").getTimezoneOffset(), -330);
});

test("a UTC timestamp is shown in local time (17:12 UTC -> 22:42 IST)", () => {
  assert.equal(fmt.dateTime("2026-10-07T17:12:00Z"), "2026-10-07 22:42");
  assert.equal(fmt.time("2026-10-07T17:12Z"), new Date(Date.UTC(2026, 9, 7, 17, 12)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  assert.match(fmt.time("2026-10-07T17:12Z"), /10:42|22:42/);   // 12- or 24-hour clock, but never 17:12
});

test("an offset timestamp is converted too", () => {
  assert.equal(fmt.dateTime("2026-10-07T17:12:00+00:00"), "2026-10-07 22:42");
});

test("the local date can be the next day", () => {
  assert.equal(fmt.date("2026-10-07T20:00:00Z"), "2026-10-08");          // 01:30 IST on the 8th
  assert.equal(fmt.dateTime("2026-10-07T20:00:00Z"), "2026-10-08 01:30");
});

test("seconds for the activity log", () => {
  assert.match(fmt.time("2026-10-07T17:12:05.123Z", { seconds: true }), /^22:42:05$/);
});

test("plain dates are not shifted", () => {
  assert.equal(fmt.date("2026-10-06"), "2026-10-06");
});

test("missing values", () => {
  assert.equal(fmt.date(null), "—");
  assert.equal(fmt.dateTime(""), "—");
  assert.equal(fmt.time(null), "");
});
