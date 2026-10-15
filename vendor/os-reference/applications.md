# Applications, launcher and recovery

Several application packages can be stored on one device. They are files on a
prepared persistent provider, normally removable storage. Installed does not mean
resident: the present execution model admits one foreground Lua application plus
isolated compute workers. Applications use the same resource interfaces regardless
of whether the package was supplied with the device or written by the user.

Discover `/sys/apps` and its live catalog. `list {cursor,limit}` returns installed
references and the device-selected factory packages, including their source
repository/path. Read those references when adapting the default launcher to the
current hardware; do not assume that an ESP32 chip model chooses a UI or button map.

An application descriptor is a normal file:

```json
{
  "format": "wishos-app/1",
  "id": "reader",
  "title": "Reading",
  "entry": "main.lua",
  "requires": [{"path":"/sys/ui","methods":["open","update"]}],
  "help": {"start":"Choose a book", "controls":"Show the actual configured controls"},
  "source": {"repository":"https://github.com/example/device-apps", "path":"reader"}
}
```

Entry and asset references are relative to their package files. Upload and verify
all files and run native `validate {manifest,package}` before
`install {manifest,package,validation_id,expected_revision,persist}` registers the descriptor.
See [package admission and whole-file revisions](packages.md) for preflight, tickets and updates. Installation
must not run the application. `launch {id,arguments}` accepts optional JSON launch arguments (read through `/sys/apps read` in `on_start`) and is asynchronous and executes at a system
loop boundary after the calling callback has returned. `home`/`exit` return to the
configured launcher; `voice` enters the configured ordinary voice application.
`configure {launcher,voice,persist}` selects installed references. Removing a
reference does not erase its files; explicit file management decides deletion.

The OS handles lifecycle, instruction/memory admission, operation completion and
owner cleanup. Native operations that cannot be interrupted finish at their safe
boundary. In particular, changing applications never interrupts an EPD waveform.
Queued display work and updates must still obey the shared presentation manager.
Application exit can stop an unfinished local recording; work already accepted by
an upstream Harness is a separate task and is not automatically undone.

The system recovery input is independent of foreground gesture handlers. Query
`/sys/navigation` for its logical buttons, hold times and current state. Do not
reassign or consume that protected entry in an application. System configuration
may choose the binding, while an ordinary application cannot remove the route out
of itself. It must remain possible to reach home/voice when the foreground consumes
other input, loops until its instruction limit, faults, or waits for display BUSY.

When generating an application or replacing the launcher:

- Explain its controls on first use and provide a discoverable help view. Show the
  actual device's configured buttons/gestures; do not invent A/B/C on a one-button
  or touch device. Distinguish short presses, holds and combinations.
- Keep a visible route home, and explain the protected recovery gesture. The
  launcher must expose available applications, network setup, storage management
  and the voice/conversation entry when the corresponding capabilities exist.
- Give feedback when an action is accepted, processing, complete or failed. Use
  declared display latency to avoid transient pages that outlast the work. Never
  label an accepted request or uploaded image as physically completed.
- Explain meaningful changes after customization: which controls changed, how to
  find help, how to return, and what happens on failure or exit. This is application
  content, not a fixed native OS page.
- Treat phone image transfer and provisioning as applications/flows. Do not create
  global active/passive/offline work modes. Normal applications use the configured
  network; temporary AP use is for provisioning or local transfer.

The launcher is replaceable application code. Its being supplied by the hardware
package gives it no separate runtime engine or special hardware access. Essential
system recovery and lifecycle coordination remain OS responsibilities.

Services started by a runtime application retain its owner for cleanup. NFS and BLE
stop after the owning instance exits; SDK teardown may finish asynchronously. A
service started from system control has system lifetime. Thread releases its native
stack on owner exit. The current Zigbee SDK can only pause its retained graph until
reboot; that restriction is declared by its adapter rather than disguised as full
resource release. Protecting a return gesture also protects its native wake source
on devices where the sleep adapter supports it.


External application clients should use a surface/context created by their running
application, rather than leave anonymous system surfaces behind. The supplied
phone image app creates its view and publishes `/app/photo/context`; its browser
client writes to that view. Leaving the app then releases its route, view and
unstarted work through ordinary ownership cleanup. The browser converter is
bundled offline; it is not a privileged system rendering path.
