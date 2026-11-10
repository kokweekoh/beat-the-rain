"""Backtest: does rain at nearby stations warn of rain at the home station, and how early?"""
import json, glob, math, sys, datetime as dt

if len(sys.argv) != 3:
    sys.exit("usage: backtest.py DATA_DIR HOME_STATION_ID (e.g. S123)")
DAYS, HOME = sys.argv[1], sys.argv[2]
STEP = dt.timedelta(minutes=5)
DRY_BEFORE = 6        # home must be dry for 30 min before an onset
LOOKAHEAD = 12        # an alert "comes true" if home rains within 60 min

readings, stations = {}, {}
for f in sorted(glob.glob(DAYS + "/*.json")):
    j = json.load(open(f))
    stations.update(j["stations"])
    for ts, v in j["readings"].items():
        readings[dt.datetime.fromisoformat(ts)] = v
times = sorted(readings)
t0, t1 = times[0], times[-1]
grid = []
t = t0
while t <= t1:
    grid.append(t); t += STEP
idx = {t: i for i, t in enumerate(grid)}


def km(a, b):
    la1, lo1 = stations[a][:2]; la2, lo2 = stations[b][:2]
    x = math.radians(lo2 - lo1) * math.cos(math.radians((la1 + la2) / 2)); y = math.radians(la2 - la1)
    return 6371 * math.hypot(x, y)


def val(i, s):
    r = readings.get(grid[i])
    if r is None or s not in r: return None
    return r[s]


def wet(i, s):
    v = val(i, s); return v is not None and v > 0


def home_dry_run(i, n):
    return all(val(j, HOME) == 0 for j in range(i - n, i))


print(f"Period: {t0:%Y-%m-%d %H:%M} to {t1:%Y-%m-%d %H:%M}, {len(times)} readings of {len(grid)} expected")
print(f"Home station: {HOME} {stations[HOME][2]}")

# home onsets
onsets = [i for i in range(DRY_BEFORE, len(grid)) if wet(i, HOME) and home_dry_run(i, DRY_BEFORE)]
print(f"Rain onsets at home station (after >=30 min dry): {len(onsets)}\n")

for R in (2.0, 3.0, 4.0, 5.0):
    nb = [s for s in stations if s != HOME and km(HOME, s) <= R]
    leads = []
    for i in onsets:
        j = i - 1; gap = 0; start = None
        while j >= i - 12:
            if any(wet(j, s) for s in nb):
                start = j; gap = 0
            else:
                gap += 1
                if gap > 1: break
            j -= 1
        leads.append(0 if start is None else (i - start) * 5)
    # alerts: neighbour rain starts while home is dry and no neighbour rain in previous 30 min
    alerts = hits = 0; hit_leads = []
    i = DRY_BEFORE
    while i < len(grid) - LOOKAHEAD:
        if (any(wet(i, s) for s in nb) and not any(wet(k, s) for k in range(i - 6, i) for s in nb)
                and val(i, HOME) == 0 and home_dry_run(i, DRY_BEFORE)):
            alerts += 1
            k = next((k for k in range(i + 1, i + 1 + LOOKAHEAD) if wet(k, HOME)), None)
            if k is not None:
                hits += 1; hit_leads.append((k - i) * 5)
            i += 6
        else:
            i += 1
    n = len(leads); srt = sorted(leads)
    pct = lambda m: 100 * sum(l >= m for l in leads) / n if n else 0
    med = srt[n // 2] if n else 0
    print(f"Radius {R:.0f} km: {len(nb)} neighbour stations")
    print(f"  Home onsets warned in advance: {pct(5):.0f}%  | lead >=10 min: {pct(10):.0f}%  | >=15 min: {pct(15):.0f}%  | median lead {med} min")
    print(f"  Beat an 8-min walk (lead >8, i.e. >=10 at 5-min resolution): {pct(10):.0f}% of onsets")
    print(f"  Lead times (min): {srt}")
    print(f"  Alerts raised: {alerts}, followed by home rain within 60 min: {hits} ({100*hits/alerts if alerts else 0:.0f}%)")
    if hit_leads:
        hl = sorted(hit_leads); print(f"  When an alert came true, rain reached home after median {hl[len(hl)//2]} min (range {hl[0]}-{hl[-1]})")
    print()
