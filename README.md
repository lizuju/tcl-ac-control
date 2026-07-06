# TCL AC Control

Local Node.js panel and scheduler for a Niagara-based AC system.

## Setup

1. Copy the example environment file:

```sh
cp .env.example .env
```

2. Edit `.env` with your Niagara URL, username, point ORDs, VAV list, and panel title.

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

4. Open the local panel:

```text
http://127.0.0.1:3033/
```

## Commands

```sh
node ac-control.mjs status
node ac-control.mjs on
node ac-control.mjs off
node ac-control.mjs temp 25
node ac-control.mjs unit-on VAV_01
node ac-control.mjs unit-off VAV_01
node ac-control.mjs unit-temp VAV_01 25
```

Scheduled `on` skips weekends and China public holidays. Manual panel `on` uses `--force`.
Whole-system commands still release and overwrite all configured unit-level overrides.

## Safety Notes

- Do not commit `.env`; it contains site-specific configuration.
- Do not store passwords in source files. `install-launchd.mjs` stores the password in macOS Keychain. Windows uses the local ignored `.env` file or process environment.
- `off`, `on`, and `temp` commands verify all configured VAV units after applying changes and retry once if needed.
