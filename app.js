// Beat the Rain: should I leave for the bus stop now, hurry, or wait?
// Signal: 5-minute rain readings from data.gov.sg gauges around the stop.
// Backtest (13–28 Oct 2026, gauge S123): with a 4 km ring, 14 of 15 rain starts
// at the stop's gauge were preceded by rain at a nearby gauge by >= 10 min;
// when an alert came true, rain arrived after a median of 25 min (10–55).

const CONFIG = {
  stopCode: "50159",
  stopName: "Bef Kim Keat Lane",
  stop: { lat: 1.32456, lng: 103.85327 },
  radiusKm: 4,
  walkMin: 8,
  recentMin: 15,       // gauge counts as "wet" if it recorded rain in the last 15 min
  staleMin: 20,        // rain data older than this is not trusted
  minLeadMin: 10,      // shortest warning seen in the backtest
  typicalLeadMin: 25,  // median warning seen in the backtest
};

const RAIN_URL = "https://api-open.data.gov.sg/v2/real-time/api/rainfall";
const FORECAST_URL = "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const BUS_URL = "https://arrivelah2.busrouter.sg/?id=";
const LOG_KEY = "btr:log";
const MIN = 60 * 1000;

// ---------- pure helpers (also used by tests) ----------

function km(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return 6371 * Math.hypot(x, y);
}

// Today's date in Singapore (UTC+8, no DST) as YYYY-MM-DD.
function sgDate(now) {
  return new Date(now.getTime() + 8 * 60 * MIN).toISOString().slice(0, 10);
}

// Summarise rain readings into per-station state around the stop.
// readings: [{timestamp, data:[{stationId, value}]}] in any order.
function summariseRain(stations, readings, cfg, now) {
  const sorted = readings
    .map(r => ({ t: new Date(r.timestamp).getTime(), data: r.data }))
    .filter(r => !Number.isNaN(r.t))
    .sort((a, b) => b.t - a.t);
  if (!sorted.length) return { error: "No rain readings returned." };
  const latestT = sorted[0].t;
  const recent = sorted.filter(r => r.t > latestT - cfg.recentMin * MIN);

  const gauges = stations
    .map(s => ({
      id: s.id,
      name: s.name,
      dist: km(cfg.stop, { lat: s.location.latitude, lng: s.location.longitude }),
    }))
    .sort((a, b) => a.dist - b.dist);
  if (!gauges.length) return { error: "No rain gauges listed." };

  for (const g of gauges) {
    const vals = recent.map(r => {
      const hit = r.data.find(d => d.stationId === g.id);
      return hit ? hit.value : null;
    });
    g.now = vals[0];                                   // latest reading (null = no report)
    g.recentMm = vals.reduce((s, v) => s + (v || 0), 0);
    g.wetNow = vals[0] > 0;
    g.wetRecent = vals.some(v => v > 0);
    g.reported = vals.some(v => v !== null);
  }
  const home = gauges.find(g => g.reported) || gauges[0];
  const ring = gauges.filter(g => g !== home && g.dist <= cfg.radiusKm);
  return { latestT, home, ring, ageMin: (now.getTime() - latestT) / MIN };
}

// Pick the forecast for the area nearest the stop.
function pickForecast(fc, cfg) {
  const items = fc && fc.items;
  const item = items && items[0];
  const areas = fc && fc.area_metadata;
  if (!item || !item.forecasts || !areas || !areas.length) return null;
  const nearest = areas
    .map(a => ({ name: a.name, dist: km(cfg.stop, { lat: a.label_location.latitude, lng: a.label_location.longitude }) }))
    .sort((a, b) => a.dist - b.dist)[0];
  const f = item.forecasts.find(x => x.area === nearest.name);
  if (!f) return null;
  return {
    area: nearest.name,
    text: f.forecast,
    rainy: /shower|rain|thunder/i.test(f.forecast),
    period: item.valid_period && item.valid_period.text,
  };
}

// The decision. rain = summariseRain() result; forecast = pickForecast() result or null.
function decide(rain, forecast, cfg) {
  if (!rain || rain.error) {
    return { v: "unsure", word: "UNSURE", margin: "Can't get rain data right now.", why: rain ? rain.error : "" };
  }
  if (rain.ageMin > cfg.staleMin) {
    return { v: "unsure", word: "UNSURE", margin: `Rain data is ${Math.round(rain.ageMin)} min old.`, why: "Look outside, or refresh in a minute." };
  }
  const { home, ring } = rain;
  const wet = ring.filter(g => g.wetRecent).sort((a, b) => a.dist - b.dist);
  const fcNote = forecast && forecast.rainy ? ` Forecast for ${forecast.area}: ${forecast.text}.` : "";

  if (home.wetNow) {
    return { v: "wait", word: "WAIT", margin: "It's raining at your stop's gauge now.",
      why: `${home.name} (${home.dist.toFixed(1)} km from the stop) recorded ${home.now} mm in the last 5 min. Check again in 10 min.` };
  }
  if (home.wetRecent) {
    return { v: "hurry", word: "HURRY", margin: "It rained here in the last 15 min and may start again.",
      why: `${home.name} is dry in the latest reading.${wet.length ? ` Still raining at ${names(wet)}.` : ""}${fcNote}` };
  }
  if (wet.length) {
    return { v: "hurry", word: "HURRY", margin: `Leave now: about ${cfg.minLeadMin}–${cfg.typicalLeadMin} min before rain reaches you. Your walk is ${cfg.walkMin} min.`,
      why: `Rain at ${names(wet)}. In past data, rain reached your stop ${cfg.minLeadMin}–${cfg.typicalLeadMin} min after nearby gauges, but often it didn't come at all.${fcNote}` };
  }
  if (forecast && forecast.rainy) {
    return { v: "go", word: "GO NOW", margin: `No rain within ${cfg.radiusKm} km yet, but ${forecast.text.toLowerCase()} forecast.`,
      why: `Forecast for ${forecast.area}${forecast.period ? `, ${forecast.period}` : ""}. Rain can start overhead without warning, so don't dawdle.` };
  }
  return { v: "go", word: "GO NOW", margin: `No rain within ${cfg.radiusKm} km in the last ${cfg.recentMin} min.`,
    why: forecast ? `Forecast for ${forecast.area}: ${forecast.text}.` : "Forecast unavailable." };
}

function names(gs) {
  const list = gs.slice(0, 3).map(g => `${g.name} (${g.dist.toFixed(1)} km)`);
  return list.join(", ") + (gs.length > 3 ? ` and ${gs.length - 3} more` : "");
}

// Next buses, soonest first, from an arrivelah response.
function nextBuses(bus, now) {
  if (!bus || !Array.isArray(bus.services)) return [];
  return bus.services
    .map(s => {
      const t = s.next && s.next.time ? new Date(s.next.time).getTime() : NaN;
      return { no: s.no, min: Math.max(0, Math.floor((t - now.getTime()) / MIN)) , t };
    })
    .filter(s => !Number.isNaN(s.t))
    .sort((a, b) => a.t - b.t);
}

// ---------- browser glue ----------

async function getJSON(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRain(now) {
  const j = await getJSON(`${RAIN_URL}?date=${sgDate(now)}`);
  let d = j && j.data;
  // Just after midnight today's list can be empty: fall back to the latest reading.
  if (!d || !d.readings || !d.readings.length) d = (await getJSON(RAIN_URL)).data;
  return d;
}

function readLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch (e) { return []; }
}
function writeLog(log) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); return true; } catch (e) { return false; }
}

function logSummary(log) {
  if (!log.length) return "No trips logged yet. Tap after each walk to see how often the verdict was right.";
  const by = {};
  for (const e of log) {
    const k = e.word || "?";
    by[k] = by[k] || { dry: 0, wet: 0 };
    by[k][e.outcome]++;
  }
  const parts = Object.entries(by).map(([k, c]) => `${k}: ${c.dry} dry, ${c.wet} wet`);
  return `${log.length} trip${log.length === 1 ? "" : "s"} logged. ${parts.join(" · ")}`;
}

if (typeof document !== "undefined") {
  const $ = id => document.getElementById(id);
  let lastVerdict = null;
  let lastLoad = 0;
  let loading = false;

  const fmt = t => new Date(t).toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" });
  const setText = (id, s) => { $(id).textContent = s; };

  $("trip").textContent = `Stop ${CONFIG.stopCode} · ${CONFIG.walkMin}-min walk`;

  function renderVerdict(v) {
    $("verdict").dataset.v = v.v;
    setText("v-word", v.word);
    setText("v-margin", v.margin);
    setText("v-why", v.why);
  }

  function renderGauges(rain) {
    const ul = $("gauges");
    ul.textContent = "";
    if (!rain || rain.error) { ul.innerHTML = '<li class="muted">Unavailable</li>'; setText("g-asof", ""); return; }
    setText("g-asof", `· as of ${fmt(rain.latestT)}`);
    for (const g of [rain.home, ...rain.ring]) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = `${g.name}${g === rain.home ? " (your stop)" : ""}`;
      const val = document.createElement("span");
      if (!g.reported) val.textContent = `${g.dist.toFixed(1)} km · no data`;
      else val.textContent = `${g.dist.toFixed(1)} km · ${g.recentMm > 0 ? g.recentMm.toFixed(1) + " mm" : "dry"}`;
      if (g.wetRecent) li.className = "wet";
      li.append(name, val);
      ul.append(li);
    }
  }

  function renderBuses(list, failed) {
    const el = $("buses");
    el.textContent = "";
    if (failed) { el.innerHTML = '<span class="muted">Bus times unavailable</span>'; return; }
    if (!list.length) { el.innerHTML = '<span class="muted">No buses reported</span>'; return; }
    for (const b of list.slice(0, 6)) {
      const s = document.createElement("span");
      const no = document.createElement("b");
      no.textContent = b.no;
      s.append(no, ` ${b.min === 0 ? "arriving" : b.min + " min"}`);
      el.append(s);
    }
  }

  function renderForecast(fc, failed) {
    const el = $("forecast");
    if (failed || !fc) { el.textContent = "Forecast unavailable"; return; }
    el.textContent = `${fc.area}: ${fc.text}${fc.period ? ` (${fc.period})` : ""}`;
  }

  async function load(force) {
    if (loading) return;
    if (!force && Date.now() - lastLoad < 30 * 1000) return;
    loading = true;
    $("refresh").disabled = true;
    setText("status", "Updating…");
    const now = new Date();
    const [rainR, fcR, busR] = await Promise.allSettled([
      fetchRain(now), getJSON(FORECAST_URL), getJSON(BUS_URL + encodeURIComponent(CONFIG.stopCode)),
    ]);
    const rain = rainR.status === "fulfilled"
      ? summariseRain(rainR.value.stations || [], rainR.value.readings || [], CONFIG, new Date())
      : { error: "Rain data request failed." };
    const fc = fcR.status === "fulfilled" ? pickForecast(fcR.value.data, CONFIG) : null;
    const v = decide(rain, fc, CONFIG);
    lastVerdict = v;
    renderVerdict(v);
    renderGauges(rain);
    renderForecast(fc, fcR.status !== "fulfilled");
    renderBuses(busR.status === "fulfilled" ? nextBuses(busR.value, new Date()) : [], busR.status !== "fulfilled");
    lastLoad = Date.now();
    setText("status", `Checked at ${fmt(lastLoad)}. Refreshes every 2 min while open.`);
    $("refresh").disabled = false;
    loading = false;
  }

  function addLog(outcome) {
    if (!lastVerdict || lastVerdict.v === "unsure") { setText("log-summary", "No verdict to log yet."); return; }
    const log = readLog();
    log.push({ t: Date.now(), word: lastVerdict.word, outcome });
    if (!writeLog(log)) { setText("log-summary", "Couldn't save: this browser blocks storage."); return; }
    setText("log-summary", `Logged "${outcome === "dry" ? "stayed dry" : "got wet"}" after ${lastVerdict.word}. ${logSummary(log)}`);
  }

  $("refresh").addEventListener("click", () => load(true));
  $("log-dry").addEventListener("click", () => addLog("dry"));
  $("log-wet").addEventListener("click", () => addLog("wet"));
  $("log-clear").addEventListener("click", () => {
    if (confirm("Clear all logged trips?")) { writeLog([]); setText("log-summary", logSummary([])); }
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(false); });
  setInterval(() => { if (document.visibilityState === "visible") load(true); }, 2 * 60 * 1000);

  setText("log-summary", logSummary(readLog()));
  load(true);
}

if (typeof module !== "undefined") {
  module.exports = { CONFIG, km, sgDate, summariseRain, pickForecast, decide, nextBuses, logSummary };
}
