import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	appendRecoveryJournalLine,
	readAndRepairRecoveryJournal,
	replaceRecoveryJournal,
	withRecoveryJournalLock,
} from "./recovery-journal-file.js";

export interface WorkerRecoveryRecord {
	version: 1;
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
	busy: boolean;
	operation: string;
	recordedAt: string;
}

export interface WorkerRecoveryPreservationOptions {
	rootActiveSessionId: string;
	rootSessionFile?: string;
	markInterrupted: (
		sessionFile: string,
		activeSessionId: string,
		operations: string[],
		recoveryId: string,
	) => Promise<void>;
	beforeJournalUpdate?: () => Promise<void>;
}

function parseRecords(path: string): Map<string, WorkerRecoveryRecord> {
	const latest = new Map<string, WorkerRecoveryRecord>();
	let contents: string;
	try {
		contents = withRecoveryJournalLock(path, () => readAndRepairRecoveryJournal(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return latest;
		}
		throw error;
	}
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		let record: WorkerRecoveryRecord;
		try {
			record = JSON.parse(line) as WorkerRecoveryRecord;
		} catch {
			continue;
		}
		if (
			record.version === 1 &&
			typeof record.activeSessionId === "string" &&
			typeof record.sessionId === "string" &&
			typeof record.busy === "boolean" &&
			typeof record.operation === "string"
		) {
			latest.set(record.activeSessionId, record);
		}
	}
	return latest;
}

export class WorkerRecoveryJournal {
	private readonly latest: Map<string, WorkerRecoveryRecord>;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.latest = parseRecords(path);
	}

	record(input: Omit<WorkerRecoveryRecord, "version" | "recordedAt">): void {
		const previous = this.latest.get(input.activeSessionId);
		if (
			previous?.busy === input.busy &&
			previous.operation === input.operation &&
			previous.sessionFile === input.sessionFile
		) {
			return;
		}
		const record: WorkerRecoveryRecord = {
			version: 1,
			...input,
			recordedAt: new Date().toISOString(),
		};
		this.append(record);
		this.latest.set(record.activeSessionId, record);
		if ([...this.latest.values()].every((entry) => !entry.busy)) {
			this.compact();
		}
	}

	getLatest(): WorkerRecoveryRecord[] {
		return [...this.latest.values()];
	}

	static readLatest(path: string): WorkerRecoveryRecord[] {
		return [...parseRecords(path).values()];
	}

	private append(record: WorkerRecoveryRecord): void {
		withRecoveryJournalLock(this.path, () => {
			readAndRepairRecoveryJournal(this.path);
			appendRecoveryJournalLine(this.path, JSON.stringify(record));
		});
	}

	private compact(): void {
		withRecoveryJournalLock(this.path, () => {
			readAndRepairRecoveryJournal(this.path);
			replaceRecoveryJournal(
				this.path,
				[...this.latest.values()].map((record) => JSON.stringify(record)),
			);
		});
	}
}

export async function preserveUncertainWorkerOperations(
	journal: WorkerRecoveryJournal,
	latest: readonly WorkerRecoveryRecord[],
	options: WorkerRecoveryPreservationOptions,
): Promise<string[]> {
	const uncertain = latest.filter((record) => record.busy);
	if (uncertain.length === 0) {
		return [];
	}
	const interruptedSessions = new Map<
		string,
		{ activeSessionId: string; sessionFile: string; operations: Set<string>; recoveryIds: Set<string> }
	>();
	for (const record of uncertain) {
		const sessionFile =
			record.sessionFile ??
			(record.activeSessionId === options.rootActiveSessionId ? options.rootSessionFile : undefined);
		if (!sessionFile) {
			continue;
		}
		const key = `${record.activeSessionId}\0${sessionFile}`;
		let interrupted = interruptedSessions.get(key);
		if (!interrupted) {
			interrupted = {
				activeSessionId: record.activeSessionId,
				sessionFile,
				operations: new Set(),
				recoveryIds: new Set(),
			};
			interruptedSessions.set(key, interrupted);
		}
		interrupted.operations.add(record.operation);
		interrupted.recoveryIds.add(`${record.activeSessionId}:${record.recordedAt}`);
	}
	await Promise.all(
		[...interruptedSessions.values()].map((interrupted) =>
			options.markInterrupted(
				interrupted.sessionFile,
				interrupted.activeSessionId,
				[...interrupted.operations],
				[...interrupted.recoveryIds].sort().join("|"),
			),
		),
	);
	await options.beforeJournalUpdate?.();
	for (const record of latest) {
		journal.record({
			activeSessionId: record.activeSessionId,
			sessionId: record.sessionId,
			...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
			busy: false,
			operation: "recovery_hold",
		});
	}
	return uncertain.map((record) => record.operation);
}
