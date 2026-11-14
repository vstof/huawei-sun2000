# Changelog

All notable changes to this integration are documented here.

## [1.5.0]

### Added

- **Two dashboard widgets** (declared in the manifest, rendered by the Gladys
  core — no custom HTML/CSS, every text is a native `{ en, fr }` object):
  - `huawei-overview`: live AC power tile (bound to the feature, animates at
    each poll), a gauge against the rated power, today / month / year tiles,
    a bar chart of the last 7 days, and status lines for the inverter state
    and the grid exchange (importing / exporting / balanced);
  - `huawei-production`: the three production totals, the inverter's lifetime
    counter, a bar chart of the last 30 days and the months of the running
    year.
- **Production statistics per day / month / year** (`src/stats.js`): the
  inverter only gives the daily yield (register 32114) and the lifetime total;
  the month and year totals are accumulated locally, day after day, in a
  JSON file under `/data` (the only writable location of the sandbox,
  written atomically). Days when nothing was read (offline) are simply
  absent from the series — no value is invented; a lower daily reading
  within a day is ignored (monotonic register); a corrupt file starts clean
  instead of crashing.
- **Bilingual code** (`src/i18n.js`): every user-facing string moved to a
  single translation table. Where Gladys natively localizes (config schema,
  action results, connection status, widget texts), the code carries
  `{ en, fr }` objects; the device and feature names — stored once by Gladys,
  with no per-language mechanism — default to **English** (switch `LOCALE`
  to `'fr'` in `src/i18n.js` before creating the device to store French
  names instead).

### Changed

- New device and feature names in English ("Huawei SUN2000 inverter",
  "AC power", "Daily yield"...). Existing devices keep their stored names:
  delete the device and let the integration rediscover it to get the new
  ones.
- `huawei-sun2000-gladys:1.5.0` image.

## [1.3.0]

### Changed

- Modbus client aligned with the behavior of the working community
  integrations (gboulvin's Gladys integration, wlcrs/huawei_solar), which
  matters on the inverter's **built-in Wi-Fi (port 6607)**:
  - the client now **waits 1 s after the TCP handshake** before sending the
    first request — the first frame sent right after connecting is often
    silently dropped by the Huawei modules;
  - `TCP_NODELAY` is set (no Nagle) after connecting;
  - a **late or unexpected answer is discarded** and the connection kept,
    instead of dropping the connection (reconnect churn);
  - a **clean close during an exchange** rejects that exchange immediately
    (and it is retried on a fresh connection) instead of waiting for the
    timeout;
  - a **connection attempt that hangs is bounded** by the same 10 s timeout.
- Polling is lighter: the 75-register identity block is no longer read every
  cycle (it never changes) — only on the "Test the connection" action. The
  power block alone qualifies the reachability, as in the community
  integration.

## [1.2.0]

### Changed

- The Modbus client keeps **one persistent TCP connection** (opened on the
  first exchange, closed after 30 s of inactivity, retried once on a fresh
  connection after any failure). Some inverters — in particular the built-in
  Wi-Fi module serving Modbus TCP on port 6607 — accept a single connection
  and ignore clients that reconnect for every frame; a connection per frame
  timed out on them. This matches the Home Assistant integration behavior.
- The per-exchange timeout rises from 5 s to 10 s: the built-in Wi-Fi module
  answers slowly.
- Documentation for the "inverter built-in Wi-Fi" configuration (port 6607,
  Local O&M enabled, slave id 0 or 1).

## [1.1.0]

### Added

- On/off switch for the inverter (`Marche / Arrêt de l'onduleur`): writes the
  heartbeat register 49999 (value 1) then the startup (40200) or shutdown
  (40201) command register with value 0, exactly like the Home Assistant
  integration. The switch state is derived from the status register 32089
  (shutdown codes are OFF, starting/on-grid codes are ON, standby codes keep
  the last known value).
- A Modbus exception (code 2) on the command register is turned into a clear
  message: the command may require installer-level permissions.

### Changed

- The switch feature is the first writable feature; every other feature stays
  read-only.

## [1.0.0]

### Added

- Initial release: local (no cloud) Modbus TCP driver for Huawei SUN2000
  inverters (Smart Dongle / SmartLogger, port 502, slave id 0).
- Discovery of one read-only device with 29 features: AC/DC power, day peak,
  daily and total yields, PV strings 1-4 voltage and current, grid voltages,
  phase currents, reactive power, power factor, frequency, efficiency, internal
  temperature, device status and fault code, plus the Smart Power Sensor block
  (signed grid power, imported and exported energy) when a power meter is
  installed.
- Five independent Modbus blocks (identity, strings, power, energy, meter): a
  block the inverter refuses only means "no data this cycle"; the identity and
  power blocks qualify the inverter as reachable.
- `test_connection` action (model, serial number, rated power, status).
- Connection status published to Gladys when the inverter becomes unreachable,
  with a bilingual message.
