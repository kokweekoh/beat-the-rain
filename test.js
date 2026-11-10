// Run with: node test.js
const assert = require("assert");
const { CONFIG, summariseRain, needsYesterday, pickForecast, decide, nextBuses, sgDate, logSummary } = require("./app.js");

const st = (id, name, lat, lng) => ({ id, name, location: { latitude: lat, longitude: lng } });
const stations = [
  st("S123", "Towner Road", 1.3270, 103.8590),   // ~0.6 km
  st("S88", "Toa Payoh North", 1.3410, 103.8550), // ~1.9 km
  st("S999", "Far Away", 1.40, 103.95),           // >4 km
];
const T = Date.parse("2026-11-10T14:00:00+08:00");
const iso = t => new Date(t).toISOString();
const reading = (minsAgo, vals) => ({ timestamp: iso(T - minsAgo * 60000), data: Object.entries(vals).map(([stationId, value]) => ({ stationId, value })) });
const now = new Date(T + 2 * 60000);
const run = (readings, fc = null) => decide(summariseRain(stations, readings, CONFIG, now), fc, CONFIG);
const dry = { S123: 0, S88: 0, S999: 0 };

assert.strictEqual(run([reading(0, dry), reading(5, dry)]).v, "go");
assert.strictEqual(run([reading(0, { ...dry, S123: 0.4 })]).v, "wait");
assert.strictEqual(run([reading(0, dry), reading(10, { ...dry, S88: 1 })]).v, "hurry");
assert.strictEqual(run([reading(0, dry), reading(15, { ...dry, S88: 1 })]).v, "go", "older than 15 min is ignored");
assert.strictEqual(run([reading(0, { ...dry, S999: 5 })]).v, "go", "outside the ring is ignored");
assert.strictEqual(run([reading(0, dry), reading(5, { ...dry, S123: 0.2 })]).v, "hurry", "home rained recently");
assert.strictEqual(decide(summariseRain(stations, [reading(0, dry)], CONFIG, new Date(T + 30 * 60000)), null, CONFIG).v, "unsure", "stale");
assert.strictEqual(run([]).v, "unsure");
assert.strictEqual(decide({ error: "x" }, null, CONFIG).v, "unsure");
// order of readings must not matter
assert.strictEqual(run([reading(10, { ...dry, S88: 1 }), reading(0, dry)]).v, "hurry");

// a partial newest reading without the home gauge: home is judged on its own last report
assert.strictEqual(run([reading(0, { S88: 0 }), reading(5, { ...dry, S123: 1 })]).v, "wait", "home uses its own last report");
// whole feed stale => unsure with a data-age message
assert.match(decide(summariseRain(stations, [reading(0, dry)], CONFIG, new Date(T + 30 * 60000)), null, CONFIG).why, /min old/);
// an old check is dropped rather than locked as the trip
assert.strictEqual(require("./app.js").pendingOnShow({ t: T, word: "GO NOW" }, T + 50 * 60000, CONFIG), null);
// nothing reported near the stop => unsure, not GO NOW
assert.strictEqual(run([{ timestamp: iso(T), data: [] }]).v, "unsure");
// malformed input doesn't throw
assert.strictEqual(decide(summariseRain([{ id: "S1" }, null], [{ timestamp: iso(T) }, null], CONFIG, now), null, CONFIG).v, "unsure");
assert.strictEqual(decide(summariseRain(stations, [reading(0, { ...dry, S123: null })], CONFIG, now), null, CONFIG).v, "go", "null home falls back to next gauge");
// only far gauges reported => unsure, never a far gauge labelled "your stop"
assert.strictEqual(run([reading(0, { S999: 0 })]).v, "unsure", "home must be within homeMaxKm");
// newest reading is missing the home gauge while it was raining there => still WAIT
assert.strictEqual(run([reading(0, { S88: 0, S999: 0 }), reading(5, { ...dry, S123: 1 })]).v, "wait", "missing is not dry");
// rain in a partial newest reading still counts as wet nearby
assert.strictEqual(run([reading(0, { S88: 2 }), reading(5, dry)]).v, "hurry", "partial rain counts");

// trip log: verdict at departure is kept
const { pendingOnHide, pendingOnShow } = require("./app.js");
const go = { v: "go", word: "GO NOW" }, wait = { v: "wait", word: "WAIT" };
let p = pendingOnHide(null, go, T, 0);
assert.deepStrictEqual(p, { t: T, word: "GO NOW" });
p = pendingOnShow(p, T + 3 * 60000, CONFIG);               // back after 3 min: not locked
assert.strictEqual(pendingOnHide(p, wait, T + 4 * 60000, 0).word, "WAIT", "re-check before leaving overwrites");
p = pendingOnShow(p, T + 20 * 60000, CONFIG);              // back after the walk: locked
assert.strictEqual(p.locked, true);
assert.strictEqual(pendingOnHide(p, wait, T + 21 * 60000, 0).word, "GO NOW", "locked survives later hides");
assert.strictEqual(pendingOnHide(null, go, T, T - 5 * 60000), null, "no new trip right after logging");
assert.strictEqual(pendingOnHide({ t: T, word: "GO NOW" }, { v: "unsure" }, T + 60000, 0), null, "unsure clears unlocked");

// midnight: a short list needs yesterday's readings too
assert.strictEqual(needsYesterday([reading(0, dry), reading(5, dry)], CONFIG), true);
assert.strictEqual(needsYesterday([reading(0, dry), reading(15, dry)], CONFIG), false);
assert.strictEqual(needsYesterday([], CONFIG), true);

const fc = { area_metadata: [{ name: "Toa Payoh", label_location: { latitude: 1.335, longitude: 103.85 } }, { name: "Bedok", label_location: { latitude: 1.32, longitude: 103.92 } }],
  items: [{ valid_period: { text: "2 pm to 4 pm" }, forecasts: [{ area: "Toa Payoh", forecast: "Thundery Showers" }, { area: "Bedok", forecast: "Fair" }] }] };
const f = pickForecast(fc, CONFIG);
assert.strictEqual(f.area, "Toa Payoh");
assert.strictEqual(f.rainy, true);
assert.strictEqual(run([reading(0, dry)], f).v, "go");
assert.match(run([reading(0, dry)], f).margin, /thundery showers/);
assert.strictEqual(pickForecast({ area_metadata: [], items: [] }, CONFIG), null);
assert.strictEqual(pickForecast({ area_metadata: [{ name: "X" }], items: [{ forecasts: [] }] }, CONFIG), null);

const buses = nextBuses({ services: [{ no: "21", next: { time: iso(T + 9 * 60000) } }, { no: "124", next: { time: iso(T + 4 * 60000) } }, { no: "X", next: null }] }, new Date(T));
assert.deepStrictEqual(buses.map(b => [b.no, b.min]), [["124", 4], ["21", 9]]);

assert.strictEqual(sgDate(new Date("2026-11-10T17:00:00Z")), "2026-11-11");
assert.strictEqual(sgDate(new Date("2026-11-10T15:59:00Z")), "2026-11-10");
assert.match(logSummary([{ word: "GO NOW", outcome: "dry" }, { word: "GO NOW", outcome: "wet" }]), /GO NOW: 1 dry, 1 wet/);

console.log("All tests passed");
