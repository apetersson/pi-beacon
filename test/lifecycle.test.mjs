import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
// Use pi's TypeScript loader so its .js-to-.ts source resolution is preserved.
const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const beaconExtension = await createJiti(import.meta.url).import("../src/index.ts", { default: true });

test("failed and cancelled manual compactions return the beacon to idle without agent_settled", async () => {
	const handlers = new Map();
	beaconExtension({ on: (name, handler) => handlers.set(name, handler) });
	const context = {
		cwd: process.cwd(),
		model: { id: "test-model" },
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "test-session",
			getSessionName: () => undefined,
		},
	};
	const state = () =>
		JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "beacon", `${String(process.pid)}.json`), "utf8"));
	try {
		handlers.get("session_start")({}, context);
		await setImmediate();
		for (const aborted of [false, true]) {
			handlers.get("session_before_compact")({ reason: "manual", willRetry: false });
			assert.equal(state().state, "compacting");
			handlers.get("session_compact_failed")({ reason: "manual", aborted, willRetry: false, fromExtension: false });
			assert.equal(state().state, "idle");
			assert.equal(state().detail.compactionReason, undefined);
		}
	} finally {
		handlers.get("session_shutdown")();
	}
});
