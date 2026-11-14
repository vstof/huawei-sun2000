# Changelog

All notable changes to this integration are documented here.

## [Unreleased]

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
