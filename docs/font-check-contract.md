# UI font-coverage preflight

The UI renderer owns actual font resolution and glyph coverage. Hub discovers the
read-only contract, supplies static Unicode codepoints and does not guess TTF/NMF,
platform fallback, current default files or a hardware-specific glyph collection.

The Native source declares:

```json
{"font_check":{"method":"font_check","max_codepoints":384},"read_methods":"read,capabilities,fonts,font_check,..."}
```

384 is an example emitted limit, not a Host/OS constant. Hub checks the actual
positive declaration and batches no more than its reported max_codepoints. With no
declaration, schema preflight keeps ui_font_coverage_unverified rather than claiming
glyph checks passed. A declared method must be in read_methods.

```json
{"font":"system","size":19,"codepoints":[45,53,20998,38047,8722]}
```

font is the effective inherited family. size is omitted when the document/parent
has not specified one, leaving the renderer's default authoritative. The renderer
returns resolved font metadata, missing_codepoints and covered. Current font
resources may be builtin, a default system file, a registered global alias or an
explicit existing font path. It must not initialize LVGL, register a face, present
a page or persist settings as a consequence of coverage inspection.

Hub groups static label text by inherited family/size and file, normalizes supported
`${font.alias}` references, preserves supplementary Unicode points, and skips CR/LF.
A missing strict glyph rejects with ui_font_missing_glyph plus U+NNNN diagnostics;
an application's explicit missingGlyph:replace policy remains its choice and is
reported as replacement. A private/retiring/future runtime alias is deferred, not
validated using another app's binding. Runtime model text and registrations made
in on_start remain Native preparation's responsibility. This is static resource
evidence, not a proof of arbitrary script values or successful future rendering.
I/O errors, invalid/partial replies and glyph absence remain different failures.

Coverage inspection does not replace the candidate's native validation. After
explicit candidate upload, `/sys/ui validate {path,schema_only:false}` can check
resources in that target environment without presenting. Native install/activation
and matching view/revision presentation completion still require separate receipts.
Font/default/configuration/media changes invalidate prior coverage evidence; the
Host does not keep a cross-request positive glyph cache. Preflight reports identify
the updated algorithm as validator_version3, while historical receipts retain their
original validator version rather than becoming current validation evidence.

## Acceptance boundary

Host fixtures cover the observed U+2212 math-minus failure, ASCII repair, per-target
batch limits, inherited/custom/builtin/default font selection, private aliases,
replacement policy, undeclared capability and failed/invalid replies. The Native
source contract was inspected, not compiled into Hub. Native builds and live probe
validation remain owned by the terminal task; current devices without the declared
method are not advertised as supporting it. The original real generated app's
install/launch success and font_missing_glyph presentation failure are retained.
