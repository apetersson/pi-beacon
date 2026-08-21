import assert from "node:assert/strict";
import { test } from "node:test";

const { derivePhase } = await import("../src/state.ts");

test("agent run wins over everything", () => {
	const r = derivePhase({
		agentRunning: true,
		compaction: { reason: "overflow", willRetry: true },
		isIdle: false,
		hasPendingMessages: true,
	});
	assert.equal(r.state, "working");
});

test("compaction reports reason and willRetry", () => {
	const r = derivePhase({
		agentRunning: false,
		compaction: { reason: "overflow", willRetry: true },
		isIdle: false,
		hasPendingMessages: false,
	});
	assert.equal(r.state, "compacting");
	assert.equal(r.detail.compactionReason, "overflow");
	assert.equal(r.detail.willRetry, true);
});

test("not idle without agent or compaction means retrying", () => {
	const r = derivePhase({ agentRunning: false, compaction: null, isIdle: false, hasPendingMessages: false });
	assert.equal(r.state, "retrying");
});

test("settled idle with pending messages still counts as idle", () => {
	const r = derivePhase({ agentRunning: false, compaction: null, isIdle: true, hasPendingMessages: true });
	assert.equal(r.state, "idle");
	assert.equal(r.detail.pendingMessages, true);
});

test("fully settled idle", () => {
	const r = derivePhase({ agentRunning: false, compaction: null, isIdle: true, hasPendingMessages: false });
	assert.deepEqual(r.detail, { pendingMessages: false });
	assert.equal(r.state, "idle");
});
