# Changelog

All notable changes to this integration are documented here.

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
