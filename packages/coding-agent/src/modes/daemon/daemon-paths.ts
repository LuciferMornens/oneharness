import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function canonicalizeDaemonFilesystemPath(path: string): string {
	let existingAncestor = resolve(path);
	const missingSuffix: string[] = [];
	while (true) {
		try {
			const physicalAncestor = realpathSync.native(existingAncestor);
			const canonical = join(physicalAncestor, ...missingSuffix);
			return process.platform === "win32" ? canonical.toLowerCase() : canonical;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
			const parent = dirname(existingAncestor);
			if (parent === existingAncestor) {
				const unresolved = resolve(path);
				return process.platform === "win32" ? unresolved.toLowerCase() : unresolved;
			}
			missingSuffix.unshift(basename(existingAncestor));
			existingAncestor = parent;
		}
	}
}

export function defaultDaemonSocketDir(): string {
	const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return join(tmpdir(), `prime-agent-${suffix}`);
}
