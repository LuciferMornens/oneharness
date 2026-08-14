import { randomUUID } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

const JOURNAL_LOCK_ATTEMPTS = 100;
const JOURNAL_LOCK_RETRY_MS = 10;
const JOURNAL_LOCK_STALE_MS = 5000;

export function withRecoveryJournalLock<T>(path: string, action: () => T): T {
	let release: (() => void) | undefined;
	for (let attempt = 0; attempt < JOURNAL_LOCK_ATTEMPTS; attempt++) {
		try {
			release = lockfile.lockSync(path, {
				realpath: false,
				lockfilePath: `${path}.lock`,
				stale: JOURNAL_LOCK_STALE_MS,
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
				throw error;
			}
			if (attempt === JOURNAL_LOCK_ATTEMPTS - 1) {
				throw new Error(`Could not coordinate recovery journal: ${path}`);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, JOURNAL_LOCK_RETRY_MS);
		}
	}
	if (!release) {
		throw new Error(`Could not coordinate recovery journal: ${path}`);
	}
	try {
		return action();
	} finally {
		release();
	}
}

export function readAndRepairRecoveryJournal(path: string): string {
	let descriptor: number;
	try {
		descriptor = openSync(path, "r+");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return "";
		}
		throw error;
	}
	try {
		const contents = readFileSync(descriptor);
		if (contents.length === 0 || contents.at(-1) === 0x0a) {
			return contents.toString("utf8");
		}
		const lastCompleteRecordEnd = contents.lastIndexOf(0x0a) + 1;
		ftruncateSync(descriptor, lastCompleteRecordEnd);
		fsyncSync(descriptor);
		return contents.subarray(0, lastCompleteRecordEnd).toString("utf8");
	} finally {
		closeSync(descriptor);
	}
}

export function appendRecoveryJournalLine(path: string, line: string): void {
	let created = false;
	let descriptor: number;
	try {
		descriptor = openSync(path, "ax", 0o600);
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
		descriptor = openSync(path, "a", 0o600);
	}
	let needsParentSync = created;
	try {
		needsParentSync ||= fstatSync(descriptor).size === 0;
		const bytes = Buffer.from(`${line}\n`, "utf8");
		let written = 0;
		while (written < bytes.length) {
			const count = writeSync(descriptor, bytes, written, bytes.length - written);
			if (count <= 0) {
				throw new Error(`Could not append recovery journal: ${path}`);
			}
			written += count;
		}
		fchmodSync(descriptor, 0o600);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	if (needsParentSync) {
		fsyncParentDirectory(path);
	}
}

export function replaceRecoveryJournal(path: string, lines: readonly string[]): void {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(tempPath, "wx", 0o600);
		const contents = Buffer.from(`${lines.join("\n")}\n`, "utf8");
		let written = 0;
		while (written < contents.length) {
			const count = writeSync(descriptor, contents, written, contents.length - written);
			if (count <= 0) {
				throw new Error(`Could not compact recovery journal: ${path}`);
			}
			written += count;
		}
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(tempPath, path);
		fsyncParentDirectory(path);
	} finally {
		if (descriptor !== undefined) {
			closeSync(descriptor);
		}
		rmSync(tempPath, { force: true });
	}
}

function fsyncParentDirectory(path: string): void {
	if (process.platform === "win32") return;
	let directoryDescriptor: number | undefined;
	try {
		directoryDescriptor = openSync(dirname(path), "r");
		fsyncSync(directoryDescriptor);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") {
			throw error;
		}
	} finally {
		if (directoryDescriptor !== undefined) {
			closeSync(directoryDescriptor);
		}
	}
}
