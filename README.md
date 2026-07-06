# TCL AC Control

Local Node.js panel and scheduler for a Niagara-based AC system.

## Setup

1. Copy the example environment file:

```sh
cp .env.example .env
```

2. Edit `.env` with your Niagara URL, username, point ORDs, VAV list, and panel title.

3. Install the macOS LaunchAgent jobs and store the password in Keychain:

```sh
node install-launchd.mjs
```

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
```

Scheduled `on` skips weekends and China public holidays. Manual panel `on` uses `--force`.

## Safety Notes

- Do not commit `.env`; it contains site-specific configuration.
- Do not store passwords in source files. `install-launchd.mjs` stores the password in macOS Keychain.
- `off`, `on`, and `temp` commands verify all configured VAV units after applying changes and retry once if needed.
