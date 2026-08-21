/**
 * Pure state machine for pi-beacon.
 *
 * The phase is derived from three orthogonal signals so that every busy
 * condition Pi can be in maps to exactly one phase:
 *
 * - `agentRunning`  agent_start .. agent_end (an LLM run loop is open)
 * - `compaction`    session_before_compact .. session_compact
 * - `!isIdle`       covers everything else Pi considers busy: automatic
 *                   retry backoff, summarization retries, queued continuations
 */

export type CompactionReason = "manual" | "threshold" | "overflow";

export type BeaconPhase = "idle" | "working" | "compacting" | "retrying";

export interface CompactionInfo {
	reason: CompactionReason;
	willRetry: boolean;
}

export interface MachineInputs {
	agentRunning: boolean;
	compaction: CompactionInfo | null;
	isIdle: boolean;
	hasPendingMessages: boolean;
}

export interface PhaseDetail {
	compactionReason?: CompactionReason;
	willRetry?: boolean;
	pendingMessages: boolean;
}

export interface DerivedPhase {
	state: BeaconPhase;
	detail: PhaseDetail;
}

export function derivePhase(inputs: MachineInputs): DerivedPhase {
	const detail: PhaseDetail = { pendingMessages: inputs.hasPendingMessages };
	if (inputs.agentRunning) {
		return { state: "working", detail };
	}
	if (inputs.compaction) {
		return {
			state: "compacting",
			detail: {
				...detail,
				compactionReason: inputs.compaction.reason,
				willRetry: inputs.compaction.willRetry,
			},
		};
	}
	if (!inputs.isIdle) {
		return { state: "retrying", detail };
	}
	return { state: "idle", detail };
}
