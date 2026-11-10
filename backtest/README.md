# Backtest

These scripts tested the app's main assumption before it was built: does rain show up at a nearby gauge early enough to beat an 8-minute walk to the stop?

## Run it

```bash
# 1. Download past 5-minute rainfall readings (here, 16 days from 13 Oct 2026).
#    This is slow on purpose (about 2.5 s per request) because data.gov.sg rate-limits bursts.
python3 backtest/fetch.py backtest/data 2026-10-13 16

# 2. Measure the warning time against the gauge nearest the stop (S123 Towner Road).
python3 backtest/backtest.py backtest/data S123
```

`fetch.py` saves one JSON file per day and skips days already downloaded, so you can stop it and start it again. `backtest/data/` is git-ignored.

## What it measures

- **Rain start:** the home gauge records rain after at least 30 dry minutes.
- **Lead time:** for each rain start, how long gauges within 2, 3, 4 and 5 km had already been recording rain without a break. It looks back at most 60 minutes, so 60 means "at least 60".
- **Alert:** a nearby gauge starts raining while the home gauge is dry. An alert *came true* if the home gauge got rain within 60 minutes.

Readings come every 5 minutes, so lead times are only accurate to about 5 minutes.

## Result (13–28 Oct 2026, home gauge S123)

| Radius | Gauges | Rain starts with ≥ 10 min warning | Median lead | Alerts that came true |
|---|---|---|---|---|
| 3 km | 5 | 11 of 15 | 15 min | 7 of 13 |
| **4 km** | 9 | **14 of 15** | 25 min | **7 of 18** |
| 5 km | 15 | 14 of 15 | 40 min | 5 of 19 |

The app uses 4 km. It almost never misses rain, but most alerts are false alarms. That trade-off suits one person deciding when to walk: a false alarm only means hurrying for nothing, while a miss means getting wet.

These are only 15 rain starts, which is enough to try the idea but not to fine-tune it. The app's "Stayed dry / Got wet" log will give better evidence.
