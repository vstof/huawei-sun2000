# Changelog

All notable changes to this integration are documented here.

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
