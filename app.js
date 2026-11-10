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
  homeMaxKm: 2,        // the "at your stop" gauge must be this close, else UNSURE
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
// Readings are often published partially (a few stations first, the rest minutes
// later), so each gauge is judged on its own reports: a gauge missing from a reading
// is "unknown", never "dry". Data age is the age of the home gauge's latest report.
function summariseRain(stations, readings, cfg, now) {
  const sorted = (readings || [])
    .map(r => ({ t: new Date(r && r.timestamp).getTime(), data: Array.isArray(r && r.data) ? r.data : [] }))
    .filter(r => !Number.isNaN(r.t) && r.t <= now.getTime() + 5 * MIN)
    .sort((a, b) => b.t - a.t);
  if (!sorted.length) return { error: "No rain readings returned." };

  const gauges = (stations || [])
    .filter(s => s && s.id && s.location && Number.isFinite(s.location.latitude) && Number.isFinite(s.location.longitude))
    .map(s => ({
      id: s.id,
      name: s.name || s.id,
      dist: km(cfg.stop, { lat: s.location.latitude, lng: s.location.longitude }),
    }))
    .sort((a, b) => a.dist - b.dist);

  const cutoff = now.getTime() - cfg.staleMin * MIN;
  if (sorted[0].t < cutoff) return { error: `Rain data is ${Math.round((now.getTime() - sorted[0].t) / MIN)} min old.` };
  for (const g of gauges) {
    // this gauge's own reports, newest first, within the stale window
    const reports = [];
    for (const r of sorted) {
      if (r.t < cutoff) break;
      const hit = r.data.find(d => d && d.stationId === g.id);
      if (hit && Number.isFinite(hit.value)) reports.push({ t: r.t, v: hit.value });
    }
    g.reported = reports.length > 0;
    g.lastT = g.reported ? reports[0].t : null;
    g.now = g.reported ? reports[0].v : null;
    const recent = reports.filter(x => x.t > sorted[0].t - cfg.recentMin * MIN);
    g.recentMm = recent.reduce((s, x) => s + x.v, 0);
    g.wetNow = g.now > 0;
    g.wetRecent = recent.some(x => x.v > 0);
  }
  // Home = nearest gauge, within homeMaxKm, that has reported recently.
  const home = gauges.find(g => g.dist <= cfg.homeMaxKm && g.reported);
  if (!home) {
    const near = gauges.find(g => g.dist <= cfg.homeMaxKm);
    return { error: near ? `${near.name} gauge hasn't reported in ${cfg.staleMin} min.` : "No rain gauge near your stop." };
  }
  const ring = gauges.filter(g => g !== home && g.dist <= cfg.radiusKm);
  return { latestT: home.lastT, home, ring, ageMin: (now.getTime() - home.lastT) / MIN };
}

// True when the readings don't reach back far enough to judge "recent" rain
// (just after midnight, when today's list holds only a few readings).
function needsYesterday(readings, cfg) {
  const ts = (readings || []).map(r => new Date(r && r.timestamp).getTime()).filter(t => !Number.isNaN(t));
  if (!ts.length) return true;
  return Math.max(...ts) - Math.min(...ts) < cfg.recentMin * MIN;
}

// Pick the forecast for the area nearest the stop.
function pickForecast(fc, cfg) {
  const items = fc && fc.items;
  const item = items && items[0];
  const areas = fc && fc.area_metadata;
  if (!item || !item.forecasts || !areas || !areas.length) return null;
  const nearest = areas
    .filter(a => a && a.label_location && Number.isFinite(a.label_location.latitude))
    .map(a => ({ name: a.name, dist: km(cfg.stop, { lat: a.label_location.latitude, lng: a.label_location.longitude }) }))
    .sort((a, b) => a.dist - b.dist)[0];
  if (!nearest) return null;
  const f = item.forecasts.find(x => x && x.area === nearest.name);
  if (!f || typeof f.forecast !== "string") return null;
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
  const wetNow = wet.filter(g => g.wetNow);
  const fcNote = forecast && forecast.rainy ? ` Forecast for ${forecast.area}: ${forecast.text}.` : "";

  if (home.wetNow) {
    return { v: "wait", word: "WAIT", margin: "It's raining at your stop's gauge now.",
      why: `${home.name} (${home.dist.toFixed(1)} km from the stop) recorded ${home.now} mm in the last 5 min. Check again in 10 min.` };
  }
  if (home.wetRecent) {
    return { v: "hurry", word: "HURRY", margin: "It rained here in the last 15 min and may start again.",
      why: `${home.name} is dry in the latest reading.${wetNow.length ? ` Still raining at ${names(wetNow)}.` : ""}${fcNote}` };
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
    if (!r.ok) {
      // data.gov.sg sends {code, errorMsg} with error statuses, e.g. 404 "Data not found".
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); if (j && j.errorMsg) msg += ` ${j.errorMsg}`; } catch (e) {}
      throw new Error(msg);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// data.gov.sg returns HTTP 200 with {code != 0, errorMsg} on some failures.
async function getGovData(url) {
  const j = await getJSON(url);
  if (!j || j.code !== 0 || !j.data) throw new Error((j && j.errorMsg) || "Bad response");
  return j.data;
}

async function fetchRain(now) {
  let d;
  try {
    d = await getGovData(`${RAIN_URL}?date=${sgDate(now)}`);
  } catch (e) {
    // Just after midnight, today's date returns "Data not found": use yesterday's.
    if (!/not found/i.test(e.message)) throw e;
    d = { stations: [], readings: [] };
  }
  const stations = d.stations || [];
  let readings = d.readings || [];
  // Just after midnight today's list is too short to see the last 15 min: add yesterday's.
  if (needsYesterday(readings, CONFIG)) {
    const y = await getGovData(`${RAIN_URL}?date=${sgDate(new Date(now.getTime() - 24 * 60 * MIN))}`);
    readings = readings.concat(y.readings || []);
    if (!stations.length) stations.push(...(y.stations || []));
  }
  return { stations, readings };
}

const PENDING_KEY = "btr:pending";
const PENDING_MAX_MIN = 120;

function readPending(nowMs) {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY));
    return p && nowMs - p.t <= PENDING_MAX_MIN * MIN ? p : null;
  } catch (e) { return null; }
}
function writePending(p) {
  try { p ? localStorage.setItem(PENDING_KEY, JSON.stringify(p)) : localStorage.removeItem(PENDING_KEY); } catch (e) {}
}

// Which verdict a trip gets logged against.
// On hide: remember the verdict on screen, unless a trip is already locked in or
// was just logged. On return after at least a walk's time away, lock it in, so
// checking the page again after the walk can't overwrite it.
const RELOG_GUARD_MIN = 30;
function pendingOnHide(pending, verdict, nowMs, lastLoggedAt) {
  if (lastLoggedAt && nowMs - lastLoggedAt < RELOG_GUARD_MIN * MIN) return pending;
  if (pending && pending.locked) return pending;
  if (!verdict || verdict.v === "unsure") return null;
  return { t: nowMs, word: verdict.word };
}
// A check more than LOCK_MAX_MIN ago wasn't the departure (you'd have logged by
// now), so it's dropped instead of locked; the next hide records a fresh one.
const LOCK_MAX_MIN = 45;
function pendingOnShow(pending, nowMs, cfg) {
  if (!pending || pending.locked) return pending;
  const age = nowMs - pending.t;
  if (age > LOCK_MAX_MIN * MIN) return null;
  if (age >= cfg.walkMin * MIN) return { ...pending, locked: true };
  return pending;
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
  let lastLoad = 0;      // last successful load
  let lastAttempt = 0;   // last load attempt, for rate limiting
  let loading = false;

  const fmt = t => new Date(t).toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" });
  const setText = (id, s) => { $(id).textContent = s; };

  $("trip").textContent = `Stop ${CONFIG.stopCode} · ${CONFIG.walkMin}-min walk`;

  // Only touch the live region when something changed, so screen readers
  // don't re-announce the same verdict on every refresh.
  function renderVerdict(v) {
    $("verdict").dataset.v = v.v;
    for (const [id, s] of [["v-word", v.word], ["v-margin", v.margin], ["v-why", v.why]]) {
      if ($(id).textContent !== s) setText(id, s);
    }
  }

  // The trip is logged against the verdict shown when you left the page (locked in
  // when you come back after the walk), not whatever it says after the walk.
  function renderPending() {
    const p = readPending(Date.now());
    $("log-dry").disabled = $("log-wet").disabled = !p;
    $("log-discard").hidden = !p;
    $("log-pending").textContent = p
      ? `Will log against ${p.word}, shown at ${fmt(p.t)}.`
      : "Check the page before you leave, then log here after your walk.";
  }

  const LOGGED_KEY = "btr:lastLogged";
  const readLastLogged = () => { try { return Number(localStorage.getItem(LOGGED_KEY)) || 0; } catch (e) { return 0; } };
  const writeLastLogged = t => { try { localStorage.setItem(LOGGED_KEY, String(t)); } catch (e) {} };

  function showUnsure(margin, why) {
    lastVerdict = null;
    renderVerdict({ v: "unsure", word: "UNSURE", margin, why });
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
    // data.gov.sg rate-limits bursts, so even a forced refresh waits 15 s.
    const wait = (force ? 15 : 30) * 1000 - (Date.now() - lastAttempt);
    if (wait > 0) {
      if (force) setText("status", `Just checked. Try again in ${Math.ceil(wait / 1000)} s.`);
      return;
    }
    lastAttempt = Date.now();
    loading = true;
    $("refresh").disabled = true;
    setText("status", "Updating…");
    try {
      const now = new Date();
      const [rainR, fcR, busR] = await Promise.allSettled([
        fetchRain(now), getGovData(FORECAST_URL), getJSON(BUS_URL + encodeURIComponent(CONFIG.stopCode)),
      ]);
      const rain = rainR.status === "fulfilled"
        ? summariseRain(rainR.value.stations, rainR.value.readings, CONFIG, new Date())
        : { error: "Rain data request failed." };
      const fc = fcR.status === "fulfilled" ? pickForecast(fcR.value, CONFIG) : null;
      const v = decide(rain, fc, CONFIG);
      lastVerdict = v;
      renderVerdict(v);
      renderGauges(rain);
      renderForecast(fc, fcR.status !== "fulfilled");
      renderBuses(busR.status === "fulfilled" ? nextBuses(busR.value, new Date()) : [], busR.status !== "fulfilled");
      lastLoad = Date.now();
      setText("status", `Checked at ${fmt(lastLoad)}. Refreshes every 2 min while open.`);
    } catch (e) {
      showUnsure("Something went wrong reading the data.", String((e && e.message) || e));
      renderGauges(null);
      renderForecast(null, true);
      renderBuses([], true);
      setText("status", "Update failed. Tap Refresh to try again.");
    } finally {
      $("refresh").disabled = false;
      loading = false;
    }
  }

  function addLog(outcome) {
    const p = readPending(Date.now());
    if (!p) { renderPending(); return; }
    const log = readLog();
    log.push({ t: p.t, loggedAt: Date.now(), word: p.word, outcome });
    if (!writeLog(log)) { setText("log-summary", "Couldn't save: this browser blocks storage."); return; }
    writePending(null);
    writeLastLogged(Date.now());
    renderPending();
    setText("log-summary", `Logged "${outcome === "dry" ? "stayed dry" : "got wet"}" after ${p.word}. ${logSummary(log)}`);
  }

  $("refresh").addEventListener("click", () => load(true));
  $("log-dry").addEventListener("click", () => addLog("dry"));
  $("log-wet").addEventListener("click", () => addLog("wet"));
  $("log-clear").addEventListener("click", () => {
    if (confirm("Clear all logged trips?")) { writeLog([]); setText("log-summary", logSummary([])); }
  });
  $("log-discard").addEventListener("click", () => { writePending(null); renderPending(); });
  document.addEventListener("visibilitychange", () => {
    const now = Date.now();
    if (document.visibilityState === "hidden") {
      writePending(pendingOnHide(readPending(now), lastVerdict, now, readLastLogged()));
    } else {
      writePending(pendingOnShow(readPending(now), now, CONFIG));
      renderPending();
      // Don't leave an old verdict on screen while the new one loads.
      if (now - lastLoad > CONFIG.staleMin * MIN) showUnsure("Checking…", "The last check was a while ago.");
      load(false);
    }
  });
  setInterval(() => { if (document.visibilityState === "visible") load(true); }, 2 * 60 * 1000);

  setText("log-summary", logSummary(readLog()));
  // A home-screen app is often relaunched from scratch after the walk, so lock here too.
  writePending(pendingOnShow(readPending(Date.now()), Date.now(), CONFIG));
  renderPending();
  load(true);
}

if (typeof module !== "undefined") {
  module.exports = { CONFIG, km, sgDate, summariseRain, needsYesterday, pickForecast, decide, nextBuses, logSummary, pendingOnHide, pendingOnShow };
}
