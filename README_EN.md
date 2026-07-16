# TCL AC Control

<p>
  <a href="README.md"><kbd>中文</kbd></a>
</p>

This project provides a local web panel and scheduler for a Niagara/BMS-based AC system. It turns the original backend-style AC interface into a simpler local control panel for daily on/off control, temperature setting, per-unit status checks, and schedule management.

Deployment scope: internal AC control for TCL Building, Pazhou Street, Haizhu District, Guangzhou, Guangdong Province.

### Advantages Over The Original System

- More intuitive operation: on, off, temperature, and status are all available in one panel.
- Simpler workflow: common actions are exposed as clear buttons instead of searching through the original system pages and points.
- Mobile remote-style control: small screens switch to a large power button, temperature stepper, and quick shortcuts.
- Whole-system control: all configured AC units can be controlled together, while overriding previous per-unit settings when needed.
- Per-unit control: each AC unit has its own on, off, and temperature controls.
- Visual schedule management: open/close times and schedule enablement can be adjusted directly from the panel.
- Workday-aware scheduling: scheduled opening skips weekends and China public holidays, with holiday data handled by year.
- Schedule retries: scheduled on, off, and temperature commands retry transient network/BMS failures, with 3 attempts by default.
- Safer shutdown: close operations verify the result and retry once if needed.
- Watchdog support: the local panel and scheduler are checked periodically and recovered when they drop unexpectedly.
- macOS and Windows support: macOS uses LaunchAgent, and Windows uses Task Scheduler.

### Quick Start

1. Copy the example environment file:

```sh
cp .env.example .env
```

2. Edit `.env` with your Niagara URL, username, point ORDs, VAV list, and panel title.

To access the panel from a phone or another LAN device, set `AC_PANEL_HOST=0.0.0.0` in `.env`, then open the deploying computer's LAN IP.

3. Install the scheduler and local panel.

On macOS, this installs LaunchAgent jobs and stores the password in Keychain:

```sh
node install-launchd.mjs
```

On Windows, add `AC_PASSWORD` to the local ignored `.env` file, then install Task Scheduler jobs:

```powershell
node install-windows.mjs
```

Windows Task Scheduler triggers by the Windows system time zone. Keep the Windows time zone set to China time for `09:30` and `17:50` to mean Beijing time.

The installer also installs a watchdog. It checks the local panel and scheduled jobs every 30 minutes. If you manually disable the schedule from the panel, the watchdog will not force it back on.

Uninstall the local panel, schedules, and watchdog:

```sh
node uninstall-launchd.mjs
```

```powershell
node uninstall-windows.mjs
```

4. Open the local panel:

```text
http://127.0.0.1:3033/
```

Read-only diagnostics page:

```text
http://127.0.0.1:3033/doctor
```

### Commands

```sh
node ac-control.mjs status
node ac-control.mjs on
node ac-control.mjs off
node ac-control.mjs temp 25
node ac-control.mjs unit-on VAV_01
node ac-control.mjs unit-off VAV_01
node ac-control.mjs unit-temp VAV_01 25
node doctor.mjs
node --test
```

Scheduled `on` skips weekends and China public holidays. Manual panel `on` uses forced opening and is not blocked by holidays.

Every on, off, temperature change, or holiday skip is recorded in the local `runtime-state.json`; the diagnostics page shows the latest run result. If `AC_NOTIFY_WEBHOOK` is configured, control failures and watchdog failures send JSON notifications.

Scheduled commands retry transient failures by default. `AC_CONTROL_ATTEMPTS=3` and `AC_CONTROL_RETRY_DELAY_MS=60000` mean retry after 60 seconds, up to 3 attempts. Manual CLI and panel actions default to 1 attempt so interactive operations do not block for too long; set these two variables in `.env` to override that behavior.

### Safety Notes

- Do not commit `.env`; it contains site-specific URLs, accounts, and point configuration.
- Do not store real passwords in source files. macOS uses Keychain; Windows uses the local ignored `.env` file or process environment.
- Whole-system `off`, `on`, and `temp` commands verify all configured VAV units after applying changes and retry once if needed.
- The watchdog only restores the local panel and scheduler; it does not actively turn AC units on or off.
- Panel errors only show an error ID; detailed errors are written to the local `logs/panel.detail.log`.
- The watchdog removes log files older than 7 days.
- `runtime-state.json` stays local and is ignored by `.gitignore`.
