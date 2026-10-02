# pi-beacon

Authoritative lifecycle state for a running [Pi coding agent](https://pi.dev) instance, published where external tools can read it.

While an instance runs, pi-beacon publishes:

```text
~/.pi/agent/beacon/<pid>.json   state document, atomically rewritten
~/.pi/agent/beacon/<pid>.sock   unix socket answering get_state queries
```

## Why

Pi's TUI shows busy state as spinner text (`Working...`, `Auto-compacting...`, `Retrying (1/3) in 2s...`). That text is fragile to match and ambiguous: auto-compaction after context overflow, retry backoff, and queued follow-ups all look like "working" — or briefly like "idle" — from the outside. pi-beacon derives state from Pi's own lifecycle events _inside_ the process and distinguishes exactly:

| state        | meaning                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `working`    | an agent run loop is open (`agent_start` … `agent_end`)                                                                                     |
| `compacting` | context compaction running; `detail.compactionReason` is `manual`, `threshold`, or `overflow`; `detail.willRetry` signals overflow recovery |
| `retrying`   | Pi is busy without an open run: auto-retry backoff, summarization retries                                                                   |
| `idle`       | settled — no run, no retry, no compaction, no queued continuation                                                                           |

`idle` corresponds to Pi's `agent_settled` semantics: the coordinator-safe "it will not continue on its own" signal.

## State document

```json
{
	"schema": "pi-beacon/v1",
	"pid": 12345,
	"state": "working",
	"detail": { "pendingMessages": false },
	"model": "anthropic/claude-sonnet-4-5",
	"sessionFile": "/Users/me/.pi/agent/sessions/....jsonl",
	"sessionId": "…",
	"sessionName": "fix-login-bug",
	"cwd": "/Users/me/code/api",
	"contextUsage": { "tokens": 61234, "contextWindow": 200000, "percent": 31 },
	"startedAt": 1733234567890,
	"updatedAt": 1733234601234
}
```

The file is rewritten on every transition, with a heartbeat refresh so stale documents from crashed instances are detectable via `updatedAt`.

## Query protocol

The socket speaks one JSON object per line, RPC-style:

```bash
echo '{"type":"get_state"}' | nc -U ~/.pi/agent/beacon/12345.sock | jq .
```

```json
{"type":"response","command":"get_state","success":true,"data":{ ...state document... }}
```

Unknown commands get `success: false`. The extension is strictly read-only: the socket never injects prompts or controls the instance.

## pi-beacon vs RPC mode

The observability half of Pi's `--mode rpc`, published from inside any running instance.

Pi's RPC mode gives machine-readable state — but only over stdin/stdout of a process launched in RPC mode. pi-beacon publishes that same lifecycle truth from inside ordinary interactive sessions, read-only, keyed by PID. It is also ahead of RPC in one respect: `get_state` does not expose compaction reasons or retry backoff, while the beacon state document shows both.

What RPC mode provides that pi-beacon deliberately does not:

| Capability                                                               | RPC mode                               | pi-beacon                                                |
| ------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------- |
| Lifecycle state (`isStreaming` / `isCompacting`)                         | yes                                    | yes, plus compaction reason and retry backoff            |
| Settled signal (`agent_settled`)                                         | push                                   | same semantics via poll (file heartbeat or socket query) |
| Control (`prompt`, `steer`, `abort`, `compact`, `set_model`, `bash`)     | yes                                    | none, by design — strictly read-only                     |
| Live event stream (`message_update`, `tool_execution_*`, `queue_update`) | push                                   | none; consumers re-poll                                  |
| History access (`get_messages`, `get_entries`, `get_tree`, fork/clone)   | yes                                    | none                                                     |
| Session token/cost totals, `export_html`                                 | yes                                    | current context-window estimate only                     |
| Transport                                                                | stdin/stdout of an instance you launch | unix socket + state file next to a running instance      |

Rule of thumb: if you need to _drive_ the agent or stream its tokens, use RPC mode with a process you control. If you need to _watch_ one or many already-running instances reliably, use pi-beacon.

## Finding instances

State documents are keyed by PID. Map a terminal surface to its Pi PID the usual way (`ps -t <tty>`), then read `~/.pi/agent/beacon/<pid>.json` — or glob `~/.pi/agent/beacon/*.json` for all live instances and filter by `cwd` / `sessionName`.

### Worked example: an instance querying its own beacon

A pi session can find its own beacon by walking up its process tree to the `pi` parent, then consume its state both ways — passive file read and active socket query:

```bash
# 1) All live beacons: one <pid>.json + <pid>.sock pair per running instance.
ls -la ~/.pi/agent/beacon/

# 2) Find our own pi PID: hop up parent PIDs until the command is "pi".
#    (Same join the cmux waiters do via `ps -t <tty>`, just from inside.)
PID=$$; for i in 1 2 3 4 5; do
  P=$(ps -o ppid= -p $PID | tr -d ' ')
  [ "$P" = "1" ] && break                    # reached init without finding pi
  CMD=$(ps -o comm= -p $P)
  if [ "$(basename $CMD)" = "pi" ]; then MYPI=$P; break; fi
  PID=$P
done

# 3) Passive path: read the state document from disk. Cheap polling; works
#    from any script with no socket client.
cat ~/.pi/agent/beacon/$MYPI.json

# 4) Active path: query the unix socket for a freshly built document.
#    nc -U targets a unix domain socket instead of TCP.
echo '{"type":"get_state"}' | nc -U ~/.pi/agent/beacon/$MYPI.sock | python3 -m json.tool
```

Step 4 pretty-prints to (values from a real mid-turn observation, identifiers genericized):

```json
{
	"type": "response",
	"command": "get_state",
	"success": true,
	"data": {
		"schema": "pi-beacon/v1",
		"pid": 2251,
		"state": "working",
		"detail": { "pendingMessages": false },
		"model": "provider/model-id",
		"sessionFile": "~/.pi/agent/sessions/<project>/<timestamp>_<session-id>.jsonl",
		"sessionId": "01a023f1-...",
		"sessionName": null,
		"cwd": "/Users/me/code/project",
		"contextUsage": { "tokens": 116718, "contextWindow": 1048576, "percent": 11.13 },
		"startedAt": 1787319083497,
		"updatedAt": 1787319118165
	}
}
```

What this shows:

- The **envelope** (`type` / `command` / `success`) deliberately mirrors Pi's RPC-mode response shape; a bad command returns `"success": false` with an `error` field instead.
- The instance reported `"state": "working"` while executing step 3 — the bash call runs inside its agent run loop. A screen scraper would have to regex a spinner; the beacon just knows.
- Between the step-3 file read and the step-4 socket reply, `contextUsage.tokens` climbed and `updatedAt` advanced: the document is live, and the socket always returns a fresh snapshot rather than the last written one.
- When the turn ends, the same query flips to `"state": "idle"` — the settled signal coordinators can wait on.

## Install

```bash
pi install npm:pi-beacon
```

Then restart Pi. Requires pi 1.x and Node.js 22.19.0 or newer. Validated against pi 1.0.0.

## Related

- [`pi-presence`](https://www.npmjs.com/package/pi-presence) — per-session state files with a `working`/`blocked`/`idle`/`dormant` vocabulary and a menu-bar reader.
- [`@vanillagreen/pi-session-bridge`](https://www.npmjs.com/package/@vanillagreen/pi-session-bridge) — full control channel (prompts, steering, aborts) over a unix socket. pi-beacon deliberately does the opposite: state out, nothing in.

## License

MIT
