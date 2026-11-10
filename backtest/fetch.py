"""Download 5-minute rainfall readings for a range of past days, politely."""
import json, sys, time, urllib.request, urllib.parse, datetime, os

if len(sys.argv) != 4:
    sys.exit("usage: fetch.py OUT_DIR START_DATE(YYYY-MM-DD) DAYS")
OUT = sys.argv[1]
start = datetime.date.fromisoformat(sys.argv[2])
days = int(sys.argv[3])
BASE = "https://api-open.data.gov.sg/v2/real-time/api/rainfall"


def get(params):
    url = BASE + "?" + urllib.parse.urlencode(params)
    for attempt in range(8):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "rain-backtest"}), timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(10 * (attempt + 1)); continue
            raise
        except Exception:
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("gave up on " + url)


os.makedirs(OUT, exist_ok=True)
for i in range(days):
    day = (start + datetime.timedelta(days=i)).isoformat()
    path = os.path.join(OUT, day + ".json")
    if os.path.exists(path):
        continue
    readings, stations, token = {}, {}, None
    while True:
        p = {"date": day}
        if token: p["paginationToken"] = token
        d = get(p)["data"]
        for s in d.get("stations", []):
            stations[s["id"]] = [s["location"]["latitude"], s["location"]["longitude"], s["name"]]
        for r in d.get("readings", []):
            readings[r["timestamp"]] = {x["stationId"]: x["value"] for x in r["data"]}
        token = d.get("paginationToken")
        time.sleep(2.5)
        if not token or not d.get("readings"):
            break
    json.dump({"stations": stations, "readings": readings}, open(path, "w"))
    print(day, len(readings), "readings", flush=True)
