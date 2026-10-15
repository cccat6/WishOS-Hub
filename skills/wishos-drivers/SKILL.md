---
name: wishos-drivers
description: Discover WishOS driver capabilities and implement native hardware adapters without mixing them with application behavior. Use when inspecting device features or adding a compiled driver/device configuration.
---

Read the selected driver's own metadata and guide. A chip family does not define
wiring, sensors, pins, color spaces, supply topology or user gestures. Keep MCU/SDK
support, reusable peripheral drivers and a device's wiring/composition separate.

Native drivers declare transport/protocol, resource, configuration and lifecycle
capabilities; implementation defaults and electrical constraints belong there.
Runtime applications use system/resource calls and cannot directly own GPIO,
registers, RTOS priorities or physical bus access. Native changes can require a
new target build; application/UI changes use runtime loading.

All bus accesses, including discovery/status/error recovery, use arbitration.
Release the bus while a device works independently. Respect active device/file/
stream leases before reset, power-off, reprobe or reconfiguration. Advertise only
implemented capabilities and keep native init/teardown/scan work off the event loop.

Display implementations expose profiles, geometry, colors and completion behavior,
with recommended use cases. Raw waveform experiments are not public application
interfaces. Audio input, wake/keyword detection and speaker output are independent
capabilities; do not infer support or backend placement from another device.

Storage presence/link checks are independent of partitions, format and write
permission. Do not write media to discover it or silently round a fixed bus speed.
Distinguish device link, volume availability, I/O outcome and durable completion.

Wi-Fi saved profiles, policy, runtime intent and actual association are distinct;
a manual request owns selection until it fails according to the configured policy.
Wi-Fi/BLE and other supported radios retain their own settings and resource rules.
Ecosystem accounts, dashboards and cloud business logic belong above native drivers.
