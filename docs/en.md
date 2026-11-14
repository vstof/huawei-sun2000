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

> The configuration screen and the device names are currently localized in
> French; this document explains every field in English.

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

### Finding the inverter IP address

- In the **FusionSolar** app: *Maintenance* → *Device information* /
  *Communication log*, the dongle IP is shown there.
- In your router interface: DHCP device list (look for a "Huawei", "SUN2000"
  or unknown-named device).
- With a network scan: `nmap -sn 192.168.1.0/24`, then `nmap -p 502` on the
  candidates — the inverter is the one with port 502 open.

## Installation

The integration is a **Docker container** installed by Gladys itself.

### 1. Build the image (on the machine running Gladys)

```bash
git clone <this-repo> huawei-sun2000 && cd huawei-sun2000
npm run build:image     # = docker build, with the manifest baked into the image
```

> The `build:image` script adds the `io.gladysassistant.manifest` label: this
> is where Gladys reads the manifest for an install-by-image-name. Without it,
> the install fails with `MANIFEST_NOT_FOUND`.

### 2. Install it in Gladys

1. Go to **Integrations** → the **"Install an integration"** button (GitHub).
2. Unfold the **Developer mode** link.
3. Paste the image name: `huawei-sun2000-gladys:1.1.0`
   (the manifest is read automatically from the image labels).
4. Click **Install**.

> Gladys must have access to the Docker socket (`/var/run/docker.sock`), which
> is the case with the official `docker-compose.yml`.

### 3. Configure

1. Enter the inverter **IP address**. Port **502**, slave id **0**: the standard
   values, only to change on your installer's instruction.
2. Click **"Test the connection"**: the model, serial number and rated power
   show up when everything is correct.
3. Go to **Discovery**, create the **"Onduleur Huawei SUN2000"** device
   (French name), then place it in a room.

The features your installation does not carry (strings 3-4 on a two-input
model, grid meter without a Smart Power Sensor, B-C and C-A voltages on a
single-phase model) stay silent: no value is fabricated.

Config fields (the UI labels are in French):

| Label (fr) | Meaning |
|---|---|
| Adresse IP de l'onduleur | Inverter IP address or hostname |
| Port Modbus TCP | Modbus TCP port (default 502) |
| Adresse esclave Modbus | Modbus slave id (default 0) |
| Intervalle de rafraîchissement (s) | Refresh interval in seconds (60 minimum) |

## The energy dashboard

The "Production du jour" and "Production totale" features use the Gladys
*energy-production-sensor* category: they feed the **Energy → Production**
dashboard. The power meter features (imported / exported energy) use the
*grid-sensor* category: they feed the **grid** tracking of the same dashboard.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Test the connection" times out | TCP/IP protocol not enabled in FusionSolar, or wrong IP |
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
