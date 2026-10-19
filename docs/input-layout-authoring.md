# Capability-driven input and optional ink alignment

This change affects Host preflight and upstream authoring guidance only. Input
interpretation and navigation are ordinary runtime application behavior, while
native input capture and protected Home/voice routes remain system responsibilities.
No fixed GPIO, button count, touch requirement, scan delay or click window is added.

Authoring begins with logical button identities/count, gesture/timing support,
optional touch/axis input, current reserved system bindings and actual display
latency. Basic operations need a single-button/no-touch route. Use declared
multi-click only when suitable; otherwise configurable focus scanning/selection.
Multiple keys and axis/slider input use application semantic roles. Touch is an
additional path. Discoverable help reflects the bindings actually used.

A target may provide the ordinary `/system/lib/navigation.lua` module; consult its
actual version/API before reuse. Current entrypoints are `bind(options)` and
`axis(source,event,options,callback)`. Applications provide call/view/accept/actions/
timer/cancel/back; config.roles maps logical key/full click-count to next/previous/
left/right/up/down/activate/back, config.mode is direct/scan. Scanning moves focus
only. Keep selectable Back/Home in the ordinary action table and verify they are
reachable without touch. Do not wait for unsupported hold/release/multi-click;
choose a declared fallback. System reserved gesture timings are queried, not
copied from today's two S3s. Read-only `elements` pagination describes completed
logical geometry, including view/revision/activation/rotation. Follow cursor/more
and declared page_limit; element geometry is not an automatic application command
catalog. Keep desired/candidate geometry distinct from presented input geometry.

`labelProps.verticalAlign` is optional `start`, `center` or `end`. Host requires a
label node, explicit `metrics:"ink"` and positive integer numeric placement.height.
Content/percent heights, line metrics and non-label nodes are rejected. Omission
preserves the previous default. Offline grammar knows this field; target preflight
requires positive `label_vertical_align:"start,center,end"` metadata. An older target
without that declaration cannot receive it. Capability values remain machine enums;
prose constraints belong in separate description fields.

Preflight validator version5 identifies this new validation behavior; version4
results are not evidence for the new extension. Native preparation is authoritative
for supported resources, execution and actual glyph/layout rendering. Check real
LCD contrast, focus feedback and group alignment of icons and glyph ink. Host tests
cannot prove a displayed label is visually centered or that a user's gesture works.

## Optional minimum font size

Target capability `label_font_fit:"minFontSize"` permits `labelProps.minFontSize`.
The field must be an integer8..96 on type label, metrics ink, with positive integer
numeric fixed placement.width. The effective inherited style.fontSize is the upper
bound; an explicitly known lower bound above it rejects. When no upper size is
explicit, Host does not invent the system default; native font resolution and
preparation decide. Native fitting measures the actual glyph width, shrinks to the
lower bound and keeps existing longMode if overflow remains. Omission preserves
the original font behavior. Validator version6 covers this added grammar, positive
target declaration and inheritance-aware checks; prior version5 evidence is not
proof of this field's validity.

A narrower screen needs a tailored network layout, readable SSID and access to full
name; arbitrary shrinking is not a replacement for that. Optional ordinary
navigation config.last can order Back after main actions on modules that support
it. Help must teach real entry, confirmation, return/Home, voice hold/release,
reply preference and configuration/error paths, rather than repeating one hint.
These remain application rules and runtime resources, not kernel page cases.
