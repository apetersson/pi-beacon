/**
 * pi-beacon — authoritative lifecycle state for a running Pi instance.
 *
 * Every instance running this extension publishes its lifecycle state to:
 *
 *   ~/.pi/agent/beacon/<pid>.json   atomically rewritten state document
 *   ~/.pi/agent/beacon/<pid>.sock   unix socket, JSONL get_state queries
 *
 * The state is derived from Pi's own lifecycle events plus ctx.isIdle(), so
 * it distinguishes working, compacting (with manual/threshold/overflow
 * reason), retrying (auto-retry backoff), and settled idle — none of which
 * are reliably visible in terminal output. The extension is strictly
 * read-only towards the instance: the socket answers queries and nothing else.
 */

import { homedir } from "node:os";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server, type Socket as NetSocket } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { derivePhase, type CompactionInfo } from "./state.js";

const POLL_MS = 1000;
const HEARTBEAT_TICKS = 15;

interface BeaconDoc {
	schema: "pi-beacon/v1";
	pid: number;
	state: "idle" | "working" | "compacting" | "retrying";
	detail: {
		compactionReason?: "manual" | "threshold" | "overflow";
		willRetry?: boolean;
		pendingMessages: boolean;
	};
	model: string | null;
	sessionFile: string | null;
	sessionId: string | null;
	sessionName: string | null;
	cwd: string | null;
	contextUsage: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	} | null;
	startedAt: number;
	updatedAt: number;
}

export default function (pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let server: Server | undefined;
	let pollTimer: NodeJS.Timeout | undefined;
	let agentRunning = false;
	let compaction: CompactionInfo | null = null;
	let lastWritten = "";
	let ticksSinceWrite = 0;
	let startedAt = 0;

	const beaconDir = join(homedir(), ".pi", "agent", "beacon");
	const pid = String(process.pid);
	const sockPath = join(beaconDir, `${pid}.sock`);
	const filePath = join(beaconDir, `${pid}.json`);

	const buildDoc = (): BeaconDoc | null => {
		if (!ctx) {
			return null;
		}
		const { state, detail } = derivePhase({
			agentRunning,
			compaction,
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
		});
		const usage = ctx.getContextUsage();
		return {
			schema: "pi-beacon/v1",
			pid: process.pid,
			state,
			detail,
			model: ctx.model?.id ?? null,
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionName: ctx.sessionManager.getSessionName() ?? null,
			cwd: ctx.cwd,
			contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : null,
			startedAt,
			updatedAt: Date.now(),
		};
	};

	const writeState = (force: boolean): void => {
		const doc = buildDoc();
		if (!doc) {
			return;
		}
		const json = `${JSON.stringify(doc, null, "\t")}\n`;
		if (!force && json === lastWritten) {
			ticksSinceWrite += 1;
			if (ticksSinceWrite < HEARTBEAT_TICKS) {
				return;
			}
		}
		ticksSinceWrite = 0;
		lastWritten = json;
		const tmp = `${filePath}.${pid}.tmp`;
		try {
			writeFileSync(tmp, json, { mode: 0o600 });
			renameSync(tmp, filePath);
		} catch {
			// Best effort: a failed state write must never disturb the session.
			try {
				rmSync(tmp, { force: true });
			} catch {
				// ignore
			}
		}
	};

	const handleConnection = (conn: NetSocket): void => {
		let buffer = "";
		conn.on("data", (chunk: Buffer | string) => {
			buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length > 0) {
					conn.write(`${respond(line)}\n`);
				}
				newline = buffer.indexOf("\n");
			}
		});
		conn.on("error", () => {
			// Client vanished mid-query; nothing to clean up.
		});
	};

	const respond = (line: string): string => {
		let command = "parse";
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "get_state") {
				command = "get_state";
				const doc = buildDoc();
				if (!doc) {
					return JSON.stringify({ type: "response", command, success: false, error: "no session" });
				}
				return JSON.stringify({ type: "response", command, success: true, data: doc });
			}
		} catch {
			// fall through to parse error
		}
		return JSON.stringify({
			type: "response",
			command,
			success: false,
			error: `unknown command; expected {"type":"get_state"}`,
		});
	};

	const startBeacon = (): void => {
		if (server) {
			return;
		}
		mkdirSync(beaconDir, { recursive: true, mode: 0o700 });
		try {
			rmSync(sockPath, { force: true }); // stale socket from a dead instance
		} catch {
			// ignore
		}
		const next = createServer(handleConnection);
		next.on("error", () => {
			// Socket-level failure must never take the session down.
			server = undefined;
		});
		next.listen(sockPath, () => {
			try {
				// chmod after bind; the listen callback fires once the socket file exists.
				chmodSync(sockPath, 0o600);
			} catch {
				// ignore
			}
		});
		server = next;
		writeState(true);
	};

	const stopBeacon = (): void => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		if (server) {
			const closing = server;
			server = undefined;
			closing.close();
		}
		try {
			rmSync(sockPath, { force: true });
		} catch {
			// ignore
		}
		try {
			rmSync(filePath, { force: true });
		} catch {
			// ignore
		}
		agentRunning = false;
		compaction = null;
		lastWritten = "";
		ctx = undefined;
	};

	pi.on("session_start", (_event, context) => {
		ctx = context;
		startedAt = Date.now();
		startBeacon();
		pollTimer ??= setInterval(() => {
			writeState(false);
		}, POLL_MS);
	});

	pi.on("agent_start", () => {
		agentRunning = true;
		writeState(false);
	});

	pi.on("agent_end", () => {
		agentRunning = false;
		writeState(false);
	});

	pi.on("agent_settled", () => {
		agentRunning = false;
		compaction = null;
		writeState(false);
	});

	pi.on("session_before_compact", (event) => {
		compaction = { reason: event.reason, willRetry: event.willRetry };
		writeState(false);
	});

	pi.on("session_compact", () => {
		compaction = null;
		writeState(false);
	});

	pi.on("session_compact_failed", () => {
		compaction = null;
		writeState(false);
	});

	pi.on("session_shutdown", () => {
		stopBeacon();
	});
}
