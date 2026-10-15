---
name: wishos-applications
description: Author replaceable WishOS Lua/UI applications using discovered system interfaces. Use for pages, styles, navigation, input behavior, callbacks and application installation or replacement.
---

Read system and selected driver guidance first. UI descriptions are rendered by
the system; the package supplies content and behavior. Use the selected hardware
package's default suite as a reference, not a privileged execution layer.

Use Lua source matching the advertised runtime. Load modules through its declared
module facility and resolve paths through the runtime. Perform capability actions
in lifecycle/event callbacks rather than executing them during module loading.
Compilation during preflight does not execute on_start or prove program semantics.

Declare resource requirements in the application descriptor and handle native
admission/operation failures. Input meanings, debounce/hold/multi-click/chord
policies, rotation behavior, recording feedback and display profile choices are
runtime application data/code. They are not kernel page exceptions.

Make controls discoverable: concise first-use guidance, help, useful task feedback
and a visible way home. Keep the system's independently reachable home/voice entry.
An application may reference multiple UI/resources and share system libraries;
static references must resolve, while dynamic references need normal runtime error
handling and declared capabilities.

For updates, read the package guide. Replace complete files; do not construct
line-number patches. Build a complete immutable revision, preflight it before
transfer, and retain the old package. Activation is explicit and separate from
validated catalog installation. Never overwrite files used by a running package.
