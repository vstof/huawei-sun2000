# Huawei SUN2000 for Gladys Assistant

An external integration that monitors a **Huawei SUN2000** solar inverter
directly from your local network, with no cloud.

## What the integration does

- Reads the **production**: AC power, DC input power, day peak, daily energy,
  total energy.
- Reads the **PV strings** (1 to 4): voltage and current of each string.
- Reads the **grid side**: voltages (A-B / B-C / C-A), phase currents, reactive
  power, power factor, frequency.
- Reads the inverter state: status (standby, starting, on-grid, shut down...),
  **fault code** presence, internal temperature, efficiency.
- When a **Smart Power Sensor (DTSU666)** is installed: grid exchange power
  (imported > 0, exported < 0), cumulative imported and exported energy.
- **On/off switch** for the inverter, with a state derived from the status
  register.
- Refreshes the values every minute (configurable interval from 60 s to 1 h).

The integration is **read-only with one exception**: the "Marche / Arrêt de
l'onduleur" (inverter on/off) switch. No other setting (grid codes, power
derating, schedules...) can be changed from Gladys — on purpose, those
registers belong to the installer.

### ⚠️ The remote shutdown may be irreversible

Writing the shutdown command (register 40201) is exactly what the Home
Assistant integration does — but be aware: on **some firmwares** (observed on
SUN2000-30KTL-M3, wlcrs/huawei_solar discussion #576), the remote shutdown
works but the **remote restart fails afterwards**, even from FusionSolar. The
only reliable way to start it again is then the mobile **SUN2000** app,
connected to the inverter's **direct Wi-Fi**.

In practice: only use the remote shutdown if you know how to restart the
inverter on site (direct Wi-Fi access, installer account). The startup command,
on the other hand, has no effect on an inverter that is already running.

> All user-facing texts — the configuration screen, the action results, the
> connection status and every dashboard widget text — are natively
> `{ en, fr }`: Gladys picks your account language. The device and feature
> names are stored once and default to English (see "Device and feature
> names" below).

## Prerequisites

1. **Enable Modbus TCP** in the FusionSolar app (installer or owner account):
   *Communication configuration* → *Dongle / Inverter* → enable the **TCP/IP**
   protocol, port **502**, slave id **0**. Depending on the app version, this
   setting sits under *System → Communication settings → Network configuration*.
2. **Connect the dongle to your Wi-Fi** (the same network as Gladys): in
   FusionSolar, *Communication configuration* → *Wi-Fi*, select your network.
   The dongle must have a fixed IP or a stable DHCP lease.
3. **Know the inverter IP address** (see below).

> Supported models: SUN2000 with a Smart dongle (SDongleA-05) or SmartLogger.
> On recent models (M1, MG2, MAP0...), port 502 is available as soon as the
> TCP/IP protocol is enabled. Some dongle firmwares answer on slave id **1**
> instead of **0**: the configuration has a field for that.

### Special case: the inverter's built-in Wi-Fi (no dongle)

Some older inverters serve Modbus TCP **directly**, through their built-in
Wi-Fi module, on **port 6607** (port 502 on older firmwares) — this is what
the FusionSolar app itself uses. Three points in that case:

1. Access must be opened: in FusionSolar (**installer** account, "Device
   Commissioning"), *Settings → Router connection settings* → enable
   **"Local O&M"** (this toggle is somewhat buggy: try several times).
2. Try **slave id 0 then 1** in the configuration: depending on the firmware,
   one or the other answers.
3. The inverter accepts **a single Modbus connection at a time**: the
   integration keeps one persistent connection (like the Home Assistant
   integration), but disconnect any other tool reading the inverter.

### Finding the inverter IP address

- In the **FusionSolar** app: *Maintenance* → *Device information* /
  *Communication log*, the dongle IP is shown there.
- In your router interface: DHCP device list (look for a "Huawei", "SUN2000"
  or unknown-named device).
- With a network scan: `nmap -sn 192.168.1.0/24`, then `nmap -p 502` on the
  candidates — the inverter is the one with port 502 open.

## Installation

The integration is a **Docker container** installed by Gladys itself.

### Option 1 — Installer depuis GitHub (recommandée pour distribuer)

Gladys **reads the manifest from the repository**, then downloads the image
announced by `docker_image` — built and published automatically on **ghcr.io**
(GitHub's own registry, not Docker Hub) by the `release.yml` workflow, in
multi-architecture (amd64 + arm64 for Raspberry Pis).

One-time prerequisite: the workflow has run on GitHub, and the image package
is **public** (GitHub → your profile → Packages → the package → Package
settings → **Change visibility → Public** — private by default).

1. Go to **Integrations** → the **"Install an integration"** button.
2. Unfold **Developer mode** and pick the **GitHub** tab.
3. Paste the repository URL, then click **Install**: Gladys downloads the
   image from ghcr.io.
4. Jump to the "Configure" step below.

### Option 2 — Build the image on the Gladys machine (developer mode, no registry)

With Node on the machine:

```bash
git clone <this-repo> huawei-sun2000 && cd huawei-sun2000
npm run build:image     # = docker build, with the manifest baked into the image
```

Without Node (a Raspberry Pi for instance), with `jq` (`sudo apt install jq`):

```bash
git clone <this-repo> huawei-sun2000 && cd huawei-sun2000
docker build --label "io.gladysassistant.manifest=$(jq -c . gladys-assistant-integration.json)" \
  -t huawei-sun2000-gladys:1.4.0 .
```

> The `build:image` script adds the `io.gladysassistant.manifest` label: this
> is where Gladys reads the manifest for an install-by-image-name. Without it,
> the install fails with `MANIFEST_NOT_FOUND`.

### 2bis. Install the built image in Gladys

1. Go to **Integrations** → the **"Install an integration"** button (GitHub).
2. Unfold the **Developer mode** link.
3. Paste the image name: `huawei-sun2000-gladys:1.4.0`
   (the manifest is read automatically from the image labels).
4. Click **Install**.

> Gladys must have access to the Docker socket (`/var/run/docker.sock`), which
> is the case with the official `docker-compose.yml`.

### Configure

1. Enter the inverter **IP address**. Port **502**, slave id **0**: the standard
   values, only to change on your installer's instruction.
2. Click **"Test the connection"**: the model, serial number and rated power
   show up when everything is correct.
3. Go to **Discovery**, create the **"Huawei SUN2000 inverter"** device
   (English name by default — see "Device and feature names" below), then
   place it in a room.

The features your installation does not carry (strings 3-4 on a two-input
model, grid meter without a Smart Power Sensor, B-C and C-A voltages on a
single-phase model) stay silent: no value is fabricated.

Config fields (bilingual in the UI):

| Label (en) | Meaning |
|---|---|
| Inverter IP address | Inverter IP address or hostname |
| Modbus TCP port | Modbus TCP port (default 502) |
| Modbus slave id | Modbus slave id (default 0) |
| Refresh interval (s) | Refresh interval in seconds (60 minimum) |

## The energy dashboard

The "Daily yield" and "Total yield" features use the Gladys
*energy-production-sensor* category: they feed the **Energy → Production**
dashboard. The power meter features (imported / exported energy) use the
*grid-sensor* category: they feed the **grid** tracking of the same dashboard.

## Dashboard widgets and statistics

The integration ships **two widgets** to place on a Gladys dashboard:
*Dashboard → Edit → Add a widget → Huawei SUN2000*.

### "Huawei SUN2000" — live overview

- **Producing now**: a live tile bound to the "AC power" feature — it
  animates at every poll.
- **Gauge**: the instant power against the inverter's rated power (read on
  the "Test the connection" action).
- **Today / This month / This year** (kWh), from the statistics module
  below.
- **Bar chart of the last 7 days**.
- **Status**: the inverter state (On grid, Standby, Shutdown...) and the
  grid exchange (Importing X kW / Exporting X kW / Balanced) when a Smart
  Power Sensor is installed.

### "Huawei SUN2000 production" — statistics

- The three totals (day / month / year) and the inverter's **lifetime
  counter** (since commissioning).
- **Bar chart of the last 30 days**.
- The **month-by-month breakdown of the running year**.

### How the statistics are computed

The inverter only provides the **daily** energy (register 32114, reset every
night) and the **total** energy since commissioning. The month and year
totals are therefore **accumulated by the integration**, day after day, in a
small JSON file under `/data` — the only persistent location of the
container. The model is deliberately honest:

- at the first reading of a new day, the previous day is **closed** with its
  last known value and added to the month and year buckets;
- days when nothing was read (integration stopped, inverter unreachable)
  **do not exist** in the series: no value is invented, and the totals only
  count the history observed since the file was created;
- within a single day, a lower reading is ignored (the daily register only
  goes up);
- the file is written atomically and survives restarts; a corrupt file
  starts clean instead of taking the module down.

The widgets never read Modbus directly: they show the last poll snapshot and
the `/data` totals. Before the first successful read (startup, inverter
off), the live tiles and the gauge are absent and the widget stays readable.

### Device and feature names

The device name and its 30 feature names are stored **once** by Gladys:
there is no per-user translation mechanism for them. Since 1.4.0 they
default to **English** ("Huawei SUN2000 inverter", "AC power", "Daily
yield"...). An existing device keeps its stored names: to get the new ones,
**delete the device** (in Discovery) and create it again — the integration
rediscovers it with the English names. If you prefer French names, set
`LOCALE` to `'fr'` in `src/i18n.js` (with a rebuilt image) **before**
recreating the device.

Everything Gladys localizes natively — the configuration screen, the action
results, the connection status message and the **widget texts** — is
provided in both languages and follows your account language.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Test the connection" times out | TCP/IP protocol not enabled in FusionSolar, or wrong IP. Built-in Wi-Fi (no dongle): "Local O&M" not enabled, or wrong slave id (try 0 then 1) |
| "Test the connection" fails with connection refused | Port 502 is not open: check the protocol activation |
| Connection OK but values missing | Wrong slave id: try `1` in the configuration |
| The grid meter publishes nothing | No Smart Power Sensor installed, or its status is not "normal" |
| Strings 3-4 never show up | Your model only has 2 PV inputs: normal |
| The on/off command fails: "the inverter refused the command" | Most recent firmwares require **installer-level rights** for these writes (Modbus exception "illegal data address"): use FusionSolar with the installer account, or have the installer enable the "allow remote commands" setting |
| The connection test stops answering at night | The inverter stands by without irradiation: the registers stay readable, check the dongle Wi-Fi instead |
| Several tools fight over port 502 | The dongle serves **a single Modbus master**: do not read the registers from two tools at once |

## Notes

- The dongle is a small embedded server: a refresh interval **below one minute
  brings nothing** and stresses the communication. The default (60 s) fits most
  uses.
- The Modbus connection is **persistent**: a single TCP connection opened at
  the first read, kept between polls (closed after 30 s of inactivity,
  re-established automatically). Some firmwares — notably the built-in Wi-Fi
  of older inverters (port 6607) — accept a single connection and ignore
  clients that reconnect for every frame. After each connection, the client
  **waits 1 second** before the first frame: Huawei modules often swallow the
  request sent right after the TCP handshake.
- Huawei energies are kWh counters (gain 100): the daily yield resets at the
  inverter's local midnight.
- The grid power of the meter follows the Gladys convention (*import > 0,
  export < 0*): the raw Huawei value, of opposite sign, is flipped by the
  integration.
- The inverter status is an **enumeration** (standby, starting, on-grid, power
  limited, off-grid, shut down, spot check...): this is what register 32089
  publishes, there is no finer value locally.
- The on/off switch follows the same scheme as the Home Assistant integration
  (wlcrs/huawei_solar): heartbeat register 49999 (value 1), then value 0 written
  to 40200 (startup) or 40201 (shutdown) — the Huawei definitions state that
  the value of both commands is 0. The displayed state is derived from register
  32089: "shut down" codes → OFF, "starting / on-grid" codes → ON; in
  standby-without-irradiation nothing is published (the displayed state does
  not change).
