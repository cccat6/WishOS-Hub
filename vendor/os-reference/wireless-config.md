# Independent wireless configuration

`/sys/radio read` is the shared overview. It exposes `wifi`, `ble`, and
`ieee802154` with their own control paths. Wi-Fi/BLE changes never select a different
Thread/Zigbee stack. IEEE 802.15.4 selection still applies on MCU reboot; the other
interfaces have their own runtime/startup boundaries.

## Wi-Fi profiles and policy

Discover `/dev/wifi describe`, then read current state. The current build holds eight
profiles. Higher priority wins; equal priority uses the strongest scanned signal and
then profile ID for a deterministic tie. Disabled or `auto_connect:false` profiles
are excluded from automatic selection. Manual connection can use a manual-only
profile, but not a disabled one. Hidden profiles can be attempted without appearing
in a scan; failed attempts receive the same backoff. A working connection is never
replaced merely to guess that a hidden SSID may be present.

RF power ranges/steps, AP channel choices and client limits come from the installed
wireless adapter. Do not copy ESP32 values into a portable application. The manager
uses that adapter's defaults, schema and validation for both online edits and restored
settings; a configuration accepted by another device can be rejected before any
radio changes. SSID priority and manual selection behavior remain common system logic.

`profile_set` merges fields by ID. Omitted password preserves the existing password;
empty password explicitly means an open network. `profile_remove` forgets a profile.
These methods save by default; pass `persist:false` for a temporary edit. SSID length
is measured in bytes, up to 32. IDs use ASCII letters/digits/underscore/hyphen, up to 24.
Duplicate profile IDs and duplicate SSIDs are rejected.

```json
{"path":"/dev/wifi","method":"profile_set","args":{"id":"home","ssid":"Home","password":"replace-me","priority":100,"persist":true}}
```

`configure` accepts partial `settings` and/or a complete `profiles` replacement.
Use `expected_revision` when editing a snapshot. Validation precedes all mutation;
a persistence failure retains the old configuration. `persist:true` saves the current
complete Wi-Fi configuration. Without it, changes are runtime-only. `profiles` and
`read` omit passwords unless `include_credentials:true` is explicitly requested;
use `profile_set` to edit one field without retrieving credentials.

```json
{"path":"/dev/wifi","method":"configure","args":{"settings":{"auto_connect":true,"switch_policy":"on_disconnect"},"persist":true}}
```

Settings include:

- `enabled`: desired radio enable; `ap_enabled`, AP SSID/password/channel/client budget
  are separate from saved station profiles. Empty AP SSID uses the device MAC suffix.
- `auto_connect`: enables automatic network selection. It does not cancel a manual
  selection. It does not drop an already connected network merely when disabled.
- `selection`: `auto` or `manual`; saved `manual_profile` selects the first boot target.
  This target can connect even when automatic selection is disabled. A failed attempt
  or subsequent link loss releases it to automatic policy, subject to `auto_connect`.
- `switch_policy`: `on_disconnect` (default) keeps a healthy link; `prefer_priority`
  rescans and may move to a higher-priority usable network.
- `scan_interval_ms`, `connect_timeout_ms`, `retry_backoff_ms`, `min_dwell_ms`,
  `candidate_confirmations`: bounded scan, association, retry and anti-flapping behavior.
- `roam_same_priority` plus `rssi_hysteresis_db`: optional signal-based switching among
  equal-priority SSIDs, under `prefer_priority`.
- `roam_with_sessions`: default false; active network users defer voluntary automatic
  switching. A lost link can recover regardless of such users.
- `tx_power_dbm`, `power_save`: RF power and modem policy. Existing `write` calls for
  these fields remain supported. Actual applied values are reported separately. A
  system power preset may adjust the live modem policy; restarting Wi-Fi reapplies
  its own configured RF settings. An explicit RF write reapplies even an unchanged
  configured value.

Successful association, not configuration acceptance, establishes connectivity.
Failed profiles back off in RAM, allowing other eligible profiles to be tried.
Scans, retries, RSSI observations and cooldowns never rewrite saved credentials.

## Manual choice and release

```json
{"path":"/dev/wifi","method":"connect","args":{"profile":"office"}}
```

Manual selection bypasses priority and automatic eligibility. It defaults to
`until_disconnect`: keep the selected SSID while its connection is healthy, even
when a higher-priority network is visible. Link loss or a failed connection attempt
releases the override; automatic selection then chooses the highest-priority usable
saved network, falling back to other eligible profiles when needed. With global
`auto_connect:false`, release leaves the station disconnected instead.

An explicit `hold:"until_resume"` locks the chosen target until released; `reconnect`
controls retries while that lock is held. `hold:"timed", hold_ms:600000` holds the
target until the deadline, including during retries or an unfinished association.
`resume_auto` hands control back to the automatic policy; its `auto_connect` flag
still applies. Releasing a hold does not itself force a switch away from a healthy
connection when `switch_policy` is `on_disconnect`.

`connect` also accepts raw SSID/password. An existing SSID reuses its profile and
password when omitted; a new one gets an ID. This legacy form saves by default;
`persist:false` makes it temporary. Explicit manual requests may disrupt network
sessions; `allow_disruption:false` defers while network users hold the link.
Switching is scheduled after the command response, and association remains asynchronous.

`disconnect` pauses station auto-selection while preserving the AP. Use
`resume_auto:true` to permit immediate automatic recovery instead. `off` turns off
the Wi-Fi radio for this runtime. Persistent disable uses `configure` with
`settings.enabled:false, persist:true`. `resume_auto` or a manual connect can leave
runtime off/paused state if the configured radio is enabled.

Runtime manual overrides do not survive MCU reboot; the saved selection policy does.
Light sleep preserves the selection/hold intent and resumes through the same manager.
Previously saved single-network credentials migrate to profile `legacy` once.

`read` distinguishes actual connectivity/SSID/IP/channel, selection ownership,
configuration persistence, pending application/association, manual target/hold,
retry cooldown and the last selection reason. AP and STA share the physical channel;
`ap_channel` is the initial preference and the AP follows an associated station.

## BLE independent configuration

```json
{"path":"/dev/ble","method":"configure","args":{"auto_start":true,"profile":{"mode":"central","name":"Notes"},"persist":true}}
```

BLE configuration has its own revision and persistence. `profile` edits merge with
saved values; a mode change clears the old mode's specific fields and validates the
new requirements. `auto_start` affects the next boot and must be persisted to survive
that boot. The read result distinguishes desired `configured.auto_start` from
`next_boot_auto_start` and states whether the current configuration was persisted.

Configuration edits do not disconnect a live BLE session. `start` uses the saved
profile plus any one-off overrides; `restart` explicitly stops/restarts using the
chosen profile. `restart_required` tracks later saved-profile changes to an active
session, not unrelated Wi-Fi changes, auto-start-only edits or deliberate one-off
start parameters. `active_profile` describes the running choice. A restart can drop
peers and may fail to initialize; configuration acceptance is not proof of pairing.

All selection/retry work runs locally. Applications or an Agent can configure policy,
observe events and conditions, or request a deliberate connection change; a model is
not invoked for routine Wi-Fi decisions.
