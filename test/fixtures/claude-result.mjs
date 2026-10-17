const mode = process.argv[2];
const at = process.argv.findIndex((a) => a === '--session-id' || a === '--resume');
const session = process.argv[at + 1];
let text = '';
for await (const part of process.stdin) text += part;
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
if (text === 'fresh') {
  console.log(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session,
      result: 'fresh-result',
    }),
  );
} else {
  if (mode === 'terminal')
    console.log(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        session_id: session,
        result: 'failed',
      }),
    );
  process.exitCode = 1;
}
