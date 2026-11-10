# Beat the Rain

A one-page tool for one trip: should I leave for my bus stop now, hurry, or wait?

It reads the live 5-minute rain gauges from data.gov.sg. If a gauge within 4 km of the stop has recorded rain in the last 15 minutes, rain is probably on its way. It also shows the 2-hour area forecast and the next buses (via [BusRouter SG](https://busrouter.sg)'s arrival proxy).

**Verdicts**
- **GO NOW:** no rain within 4 km.
- **HURRY:** rain nearby, or rain just stopped at the stop's gauge.
- **WAIT:** raining at the stop's gauge now.
- **UNSURE:** rain data missing or stale.

**Why 4 km.** I backtested 16 days of past readings (13–28 Oct 2026) against the gauge nearest the stop. A nearby gauge recorded rain at least 10 minutes earlier for 14 of 15 rain starts. When an alert came true, the rain typically arrived about 25 minutes later. Most alerts were false alarms, so HURRY means "likely", not "certain".

After each walk, tap **Stayed dry** or **Got wet**. The trip is logged against the verdict shown when you left the page. That verdict is locked in when you come back 8–45 minutes later, so checking again after the walk doesn't change it. If it isn't the trip you meant, tap **Not a trip, discard**. The log is kept in your browser and shows how often each verdict was right.

Settings (stop, walk time, radius) are in `CONFIG` at the top of `app.js`. Run the tests with `node test.js`.

Data: rainfall and forecast © data.gov.sg (Singapore Open Data Licence). Bus arrivals © LTA, via BusRouter SG / arrivelah.
