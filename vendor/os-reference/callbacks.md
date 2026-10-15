# Application callbacks

These APIs operate inside the application VM. Callback functions can be closures or
functions imported from runtime files. They do not require a firmware rebuild.

```lua
local listener
function on_start()
  listener = notes.on('/dev/buttons', 'click', function(event)
    print('Button A')
    return true
  end, {where = {button = 'A'}})

  local reply, completion = notes.request('/sys/ui', 'open', {
    path = notes.resolve('ui.json')
  }, function(event)
    if event.event == 'completed' then
      print('Display completed: ' .. event.data.completion.kind)
    else
      print('Display ended: ' .. event.data.state)
    end
  end)
  assert(reply.ok, reply.error)
end
-- Use notes.off(listener) when that registration is no longer wanted.
```

- `on(source, event, fn, options)` returns a listener token. Event is a name, a list
  of names, or nil for all events from that exact source. Options are `once` and
  `where`; where matches top-level scalar fields of `event.data` by equality.
- `off(token)` releases that listener and returns whether it existed. It cancels
  notification, not the underlying device operation. Use the device's declared
  cancel/abort/stop operation when that is intended and physically allowed.
- `request(path, method, args, fn)` reads the method's async contract, reserves its
  listener before invoking the method, then binds the reply's correlation fields.
  It returns the ordinary response and a one-shot listener token. Immediate
  rejection returns `ok:false` without leaving a listener or invoking `fn`.
  An undeclared asynchronous method returns `async_not_declared` without execution.

All matching registered listeners run in registration order. Returning exactly true
suppresses the low-level `on_event` fallback and static rules, not other registered
listeners. A listener removed by an earlier callback is skipped; a newly registered
listener starts with future events. One-shot listeners are removed before calling
user code. Manual subscribe/unsubscribe and registered listeners retain independent
interest in a source. Raw subscriptions and static rules also begin with future
input: queued events from before registration do not become actions for newly
loaded code. Repeating an existing subscription is idempotent.

Callbacks share the application's instruction/system-call and memory budgets. Their
state allocates on demand; there is no fixed per-application callback-memory block
or separate fixed handler-count quota. Source subscription capacity is discoverable
through `/sys/runtime read`. Failures follow the runtime's application fault policy.
Stopping, replacing or rebooting an application drops its callback registrations;
startup code re-registers them. They never execute in a hardware ISR.

Accepted requests reserve a completion observation independently of the lossy event
journal. Ordinary event overflow does not erase their terminal results. The runtime
recovers retained results on its next pump and releases the observation after the
one-shot callback. `off` and owner exit release it without cancelling physical work.
Direct RPC clients can use `/sys/operations request {path,method,args}`, then
`read {id:completion_id}` and `release {id}`. The ID lasts only for this boot.

The retained observation is bounded by the system resource budget and is admitted
before the operation. If an exceptional allocation failure prevents correlating a
concurrent completion before the acceptance reply is bound, `delivery_error`
reports that observation failure. Inspect the driver's result state; do not treat
it as evidence that the physical operation failed or repeat the operation blindly.


`notes.request` uses `/sys/capabilities describe` metadata:

```json
{"async":{"submit":{"source":"/sys/workers","events":["completed","failed"],"match":{"id":"id"}}}}
```

Match keys name event-data fields; values name accepted-response `result` fields.
UI requests match view ID + revision, so deferred queue admission needs no special
application code. Native display submissions, HTTP requests, compute jobs, remote
requests and microphone capture currently declare contracts. Other device events,
including buttons, timers and connection changes, use `notes.on` directly.
Large results remain in the driver's read/stream interface; the callback carries
its completion receipt and identity, not an implicit full-body download.

An idempotent remote request can return an already completed result. Its driver
contract declares a `settled` reply field/event mapping. The runtime invokes its
callback on a later pump with `replayed:true`, without re-executing the operation.
The same non-inline ordering applies to normal completions. A request uses two
resource calls (description and invocation) within the callback's call budget.

Display failures include unadmitted UI revisions replaced/closed before rendering.
These report `completion.source:not_admitted`; no hardware job is invented. Admitted
work retains the native driver's completion semantics, including noninterruptible
EPD refresh. See [display interface](display-interface.md).

For custom event dispatch, the lower-level `notes.subscribe` + `on_event` entrypoint
remains available. The factory suite and the public
`examples/agent-os/callbacks` example use the registration API.

The trusted runtime library is loaded lazily from stripped Lua 5.4.8 bytecode to
avoid spending device RAM on parsing its source/debug tables. It uses the runtime's
int64/double Lua ABI, verified on the C3 and host builds. Application/module loaders
continue to accept text only. Source and generated bytecode have a compile-time
fingerprint check; regenerate with the `notes_callback_compiler` CMake target from
`tests/os-ui`, then run that compiler with the destination
`firmware/WishOS/src/RuntimeCallbacksBytecode.h`.
