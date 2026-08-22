import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "session-1",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function makeWorker(workerId: string, summaries: SessionSummary[], sessionFile?: string) {
	return {
		descriptor: {
			workerId,
			sessionFile: sessionFile ?? summaries.find((summary) => summary.activeSessionId)?.sessionFile,
			createCommand: {
				type: "create" as const,
				sessionPath: sessionFile ?? summaries.find((summary) => summary.activeSessionId)?.sessionFile,
			},
		},
		summaries: new Map(summaries.map((summary) => [summary.activeSessionId ?? summary.id, summary])),
	};
}

function supervisorWithWorkers(workers: Array<ReturnType<typeof makeWorker>>, catalogDelete: ReturnType<typeof vi.fn>) {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers: new Map(workers.map((worker) => [worker.descriptor.workerId, worker])),
		catalog: { delete: catalogDelete },
	}) as {
		handleCommand(
			client: object,
			command: { id?: string; type: "delete_saved_session"; sessionPath: string; activeSessionId?: string },
		): Promise<{ success: boolean; data?: unknown; error?: string }>;
		sessionFileIsLiveResident(sessionFile: string): boolean;
	};
}

describe("daemon supervisor delete_saved_session occupancy", () => {
	it("deletes a file listed only as a passive/no-activeSessionId worker summary", async () => {
		const childPath = "/tmp/project/registry-child.jsonl";
		const catalogDelete = vi.fn(async () => ({ ok: true, method: "unlink" as const }));
		const supervisor = supervisorWithWorkers(
			[
				makeWorker("parent", [
					makeSummary({
						id: "root-active",
						activeSessionId: "root-active",
						sessionId: "root-session",
						sessionFile: "/tmp/project/root.jsonl",
					}),
					makeSummary({
						id: "registry-child",
						activeSessionId: undefined,
						sessionId: "registry-child",
						sessionFile: childPath,
						runtimeKind: "subagent",
						parentSessionId: "root-session",
						rlmChildId: "passive-child",
					}),
				]),
			],
			catalogDelete,
		);

		expect(supervisor.sessionFileIsLiveResident(childPath)).toBe(false);
		const response = await supervisor.handleCommand(
			{},
			{ id: "del-1", type: "delete_saved_session", sessionPath: childPath },
		);

		expect(response).toMatchObject({ success: true, data: { ok: true, method: "unlink" } });
		expect(catalogDelete).toHaveBeenCalledWith(childPath);
	});

	it("deletes a file named only by a stale worker descriptor or createCommand path", async () => {
		const stalePath = "/tmp/project/stale.jsonl";
		const catalogDelete = vi.fn(async () => ({ ok: true, method: "unlink" as const }));
		const supervisor = supervisorWithWorkers(
			[
				makeWorker(
					"stale-descriptor",
					[
						makeSummary({
							id: "other-live",
							activeSessionId: "other-live",
							sessionId: "other-session",
							sessionFile: "/tmp/project/other.jsonl",
						}),
					],
					stalePath,
				),
			],
			catalogDelete,
		);

		expect(supervisor.sessionFileIsLiveResident(stalePath)).toBe(false);
		const response = await supervisor.handleCommand(
			{},
			{ id: "del-2", type: "delete_saved_session", sessionPath: stalePath },
		);

		expect(response).toMatchObject({ success: true, data: { ok: true } });
		expect(catalogDelete).toHaveBeenCalledWith(stalePath);
	});

	it("refuses to delete a file a worker still hosts as a live session", async () => {
		const livePath = "/tmp/project/live.jsonl";
		const catalogDelete = vi.fn(async () => ({ ok: true, method: "unlink" as const }));
		const supervisor = supervisorWithWorkers(
			[
				makeWorker("live", [
					makeSummary({
						id: "live-active",
						activeSessionId: "live-active",
						sessionId: "live-session",
						sessionFile: livePath,
					}),
				]),
			],
			catalogDelete,
		);

		expect(supervisor.sessionFileIsLiveResident(livePath)).toBe(true);
		await expect(
			supervisor.handleCommand({}, { id: "del-3", type: "delete_saved_session", sessionPath: livePath }),
		).rejects.toThrow("Cannot delete the currently active session");
		expect(catalogDelete).not.toHaveBeenCalled();
	});
});
