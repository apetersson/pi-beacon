# pi-beacon

Authoritative lifecycle state for a running [Pi coding agent](https://pi.dev) instance, published where external tools can read it — no screen scraping, no spinner regexes.

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

## Finding instances

State documents are keyed by PID. Map a terminal surface to its Pi PID the usual way (`ps -t <tty>`), then read `~/.pi/agent/beacon/<pid>.json` — or glob `~/.pi/agent/beacon/*.json` for all live instances and filter by `cwd` / `sessionName`.

## Install

```bash
pi install npm:pi-beacon
```

Then restart Pi. Requires pi with extension events `session_before_compact`/`session_compact`/`agent_settled` (≥ 0.84).

## Related

- [`pi-presence`](https://www.npmjs.com/package/pi-presence) — per-session state files with a `working`/`blocked`/`idle`/`dormant` vocabulary and a menu-bar reader.
- [`@vanillagreen/pi-session-bridge`](https://www.npmjs.com/package/@vanillagreen/pi-session-bridge) — full control channel (prompts, steering, aborts) over a unix socket. pi-beacon deliberately does the opposite: state out, nothing in.

## License

MIT
