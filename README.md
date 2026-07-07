# TCL AC Control

<p>
  <a href="#中文版本"><kbd>中文</kbd></a>
  <a href="#english-version"><kbd>English</kbd></a>
</p>

## 中文版本

这是一个面向 Niagara/BMS 空调系统的本地控制面板和定时任务工具。它把原本偏后台、偏 IE 风格的空调控制界面整理成一个更直观的本地 Web 面板，方便日常打开、关闭、设置温度、查看每台空调状态和调整定时任务。

适用场景：广东省广州市海珠区琶洲街道TCL大厦-内网空调控制。

### 相比原系统的优势

- 操作更直观：打开、关闭、设置温度、查看状态都集中在同一个面板里。
- 操作逻辑更简单：不用在原系统里反复查找点位或页面，常用动作都有明确按钮。
- 支持全部空调控制：可以一键控制所有配置的空调，并覆盖单台空调之前的独立设置。
- 支持单台空调控制：每台空调都有独立的打开、关闭和温度设置入口。
- 支持可视化定时任务：可以在面板里直接调整打开时间、关闭时间，并开启或关闭定时任务。
- 自动跳过非工作日：定时开启会跳过周末和中国节假日，节假日按年份读取，适配不同年份的放假安排。
- 关闭更稳妥：关闭动作会读取状态做确认，失败时会自动重试一次。
- 支持看门狗：定期检查本地面板和定时任务，异常掉线时自动拉起。
- 支持 macOS 和 Windows：macOS 使用 LaunchAgent，Windows 使用任务计划程序。

### 快速开始

1. 复制环境变量示例：

```sh
cp .env.example .env
```

2. 编辑 `.env`，填入 Niagara 地址、账号、点位 ORD、VAV 列表、面板标题等本地配置。

3. 安装定时任务和本地面板。

macOS 会安装 LaunchAgent，并把密码保存到 Keychain：

```sh
node install-launchd.mjs
```

Windows 需要先在本地 ignored 的 `.env` 里填写 `AC_PASSWORD`，再安装任务计划程序：

```powershell
node install-windows.mjs
```

Windows 任务计划程序按 Windows 系统时区触发。如果要让 `09:30` 和 `17:50` 表示北京时间，请把 Windows 时区设为中国时间。

安装脚本会同时安装看门狗。看门狗每 30 分钟检查一次本地面板和定时任务；如果你在面板里手动关闭定时任务，它不会把定时任务强行重新开启。

4. 打开本地面板：

```text
http://127.0.0.1:3033/
```

### 命令行

```sh
node ac-control.mjs status
node ac-control.mjs on
node ac-control.mjs off
node ac-control.mjs temp 25
node ac-control.mjs unit-on VAV_01
node ac-control.mjs unit-off VAV_01
node ac-control.mjs unit-temp VAV_01 25
```

定时 `on` 会跳过周末和中国节假日。面板里的手动“打开空调”会使用强制打开，不受节假日限制。

### 安全说明

- 不要提交 `.env`，它包含现场地址、账号和点位配置。
- 不要把真实密码写入源码。macOS 使用 Keychain 保存密码；Windows 使用本地 ignored 的 `.env` 或进程环境变量。
- 全部空调的 `off`、`on`、`temp` 命令会在执行后校验所有配置的 VAV 状态，失败时自动重试一次。
- 看门狗只负责恢复本地面板和调度任务，不会主动执行打开或关闭空调。

## English Version

This project provides a local web panel and scheduler for a Niagara/BMS-based AC system. It turns the original backend-style AC interface into a simpler local control panel for daily on/off control, temperature setting, per-unit status checks, and schedule management.

### Advantages Over The Original System

- More intuitive operation: on, off, temperature, and status are all available in one panel.
- Simpler workflow: common actions are exposed as clear buttons instead of searching through the original system pages and points.
- Whole-system control: all configured AC units can be controlled together, while overriding previous per-unit settings when needed.
- Per-unit control: each AC unit has its own on, off, and temperature controls.
- Visual schedule management: open/close times and schedule enablement can be adjusted directly from the panel.
- Workday-aware scheduling: scheduled opening skips weekends and China public holidays, with holiday data handled by year.
- Safer shutdown: close operations verify the result and retry once if needed.
- Watchdog support: the local panel and scheduler are checked periodically and recovered when they drop unexpectedly.
- macOS and Windows support: macOS uses LaunchAgent, and Windows uses Task Scheduler.

### Quick Start

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

The installer also installs a watchdog. It checks the local panel and scheduled jobs every 30 minutes. If you manually disable the schedule from the panel, the watchdog will not force it back on.

4. Open the local panel:

```text
http://127.0.0.1:3033/
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
```

Scheduled `on` skips weekends and China public holidays. Manual panel `on` uses forced opening and is not blocked by holidays.

### Safety Notes

- Do not commit `.env`; it contains site-specific URLs, accounts, and point configuration.
- Do not store real passwords in source files. macOS uses Keychain; Windows uses the local ignored `.env` file or process environment.
- Whole-system `off`, `on`, and `temp` commands verify all configured VAV units after applying changes and retry once if needed.
- The watchdog only restores the local panel and scheduler; it does not actively turn AC units on or off.
