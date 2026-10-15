# Common resource model

This is the operating system's model for every driver, not a power-specific protocol.

## Layers

1. A driver declares the properties, operations, native events and constraints that it actually provides. A property declares its type, unit and access. Declaration does not depend on whether its latest reading happens to be available. An absent capability is omitted rather than represented by a negative support flag.
2. The system offers discovery, invocation, event subscription, conditions and action routing uniformly for those declarations.
3. An application chooses values, policies, conditions and resulting actions. UI text and behavior do not belong in a hardware capability declaration.

Read `/sys/capabilities list` or `describe {path}`. Device entries contain `properties`, `methods`, optional `events` and `constraints`. Access `r` means readable and `rw` means read/write. Property names such as `A.pressed` or `raw.0` identify a field in the driver's structured state. Operations use the same resource invocation mechanism; method-specific parameters and the separate policy catalog supply configuration constraints.

Do not infer a capability by inspecting a live result value. The condition service requires a declared readable property. Driver-internal ADC settling, bus timing and signal filtering do not become mandatory application workflows.

## Shared conditions

`/sys/conditions write` creates or replaces a named condition. The current implementation supports numeric, boolean and string properties, with operators `above`, `below`, `equal`, and `change`. It has 16 slots. Configurations are volatile and can be installed by an application's on_start.

Examples using the same interface:

```json
{"id":"voltage-high","source":"/dev/battery","property":"mv","operator":"above","value":3900,"hysteresis":80,"hold_ms":2000}
```

```json
{"id":"external-present","source":"/dev/battery","property":"external_power","operator":"equal","value":true,"hold_ms":200}
```

```json
{"id":"button-held","source":"/dev/buttons","property":"buttons.A.pressed","operator":"equal","value":true,"hold_ms":800}
```

```json
{"id":"memory-low","source":"/sys/stats","property":"heap_free_bytes","operator":"below","value":30000,"hysteresis":8000,"hold_ms":1000}
```

Only install an example if its source/property is declared. The external-power property is declared by the appropriate board driver when the circuit exists; there is no separate power-input service or battery-specific watch API.

`interval_ms` controls evaluation polling (default 100 ms). Conditions due on the same resource share one read per tick. `hold_ms` controls confirmation duration; numeric `hysteresis` controls the return boundary. Above enters at >=value and clears below value-hysteresis; below enters at <=value and clears above value+hysteresis. Change tracks transitions in a property's value. `emit_initial` determines whether the first matching classification produces an entered event.

Missing/invalid observations interrupt confirmation; they do not become zero or false. The last confirmed classification is retained for detecting later transitions. The engine contains no ADC, USB, battery, button, IMU or network-specific logic.

`/sys/conditions read` lists configured conditions; `remove {id}` removes one. IDs under `system:` belong to system policies. The energy policy configures `system:low-battery` through this same engine, using its settings in `/sys/config`.

## Shared actions and events

Conditions emit `entered`, `exited` or `changed` on `/sys/conditions`, carrying their ID, source, property and observation. Use `/sys/rules` or a Lua subscription to connect these to any declared operation:

```json
{"source":"/sys/conditions","event":"entered","where":{"id":"voltage-high"},"target":"/sys/ui","method":"refresh","cooldown_ms":0}
```

Native events such as a button press or completed display job use the same event/rule machinery directly. For short pulses, use native events rather than slow state polling. The application controls the response; capability declarations do not prescribe notifications, screens or shutdown behavior.
