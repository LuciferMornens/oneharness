import {
	type ChildProcess,
	type ExecFileException,
	type ExecFileOptionsWithStringEncoding,
	type ExecFileSyncOptions,
	type ExecFileSyncOptionsWithStringEncoding,
	type ExecSyncOptions,
	type ExecSyncOptionsWithStringEncoding,
	execFile,
	execFileSync,
	execSync,
	type SpawnOptions,
	type SpawnSyncOptions,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	spawn,
	spawnSync,
} from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, normalize } from "node:path";

const EXIT_STDIO_GRACE_MS = 100;

/** windowsHide for every non-interactive spawn (console children of a windowless parent flash a fresh console on Windows); only spawns that intentionally hand the user a console call node:child_process directly. */
export function spawnHidden(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
	return spawn(command, args, { ...options, windowsHide: true });
}

export function spawnSyncHidden(
	command: string,
	args: readonly string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnSyncHidden(
	command: string,
	args?: readonly string[],
	options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer>;
export function spawnSyncHidden(
	command: string,
	args: readonly string[] = [],
	options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
	return spawnSync(command, args, { ...options, windowsHide: true });
}

export function execSyncHidden(command: string, options: ExecSyncOptionsWithStringEncoding): string;
export function execSyncHidden(command: string, options?: ExecSyncOptions): Buffer;
export function execSyncHidden(command: string, options: ExecSyncOptions = {}): string | Buffer {
	return execSync(command, { ...options, windowsHide: true });
}

export function execFileHidden(
	file: string,
	args: readonly string[],
	options: ExecFileOptionsWithStringEncoding,
	callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess {
	return execFile(file, args, { ...options, windowsHide: true }, callback);
}

export function execFileSyncHidden(
	file: string,
	args: readonly string[],
	options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execFileSyncHidden(file: string, args?: readonly string[], options?: ExecFileSyncOptions): Buffer;
export function execFileSyncHidden(
	file: string,
	args: readonly string[] = [],
	options: ExecFileSyncOptions = {},
): string | Buffer {
	return execFileSync(file, args, { ...options, windowsHide: true });
}

const WINDOWS_EXACT_TREE_TERMINATION_SOURCE = `
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

public static class PrimeAgentProcessTree
{
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private sealed class HeldProcess : IDisposable
    {
        public readonly uint ProcessId;
        public readonly uint ParentProcessId;
        public readonly long CreationTicks;
        public readonly int Depth;
        public readonly IntPtr Handle;

        public HeldProcess(uint processId, uint parentProcessId, long creationTicks, int depth, IntPtr handle)
        {
            ProcessId = processId;
            ParentProcessId = parentProcessId;
            CreationTicks = creationTicks;
            Depth = depth;
            Handle = handle;
        }

        public void Dispose()
        {
            CloseHandle(Handle);
        }

        public bool HasExited()
        {
            return WaitForSingleObject(Handle, 0) == WAIT_OBJECT_0;
        }

        public bool TryGetExitTicks(out long exitTicks)
        {
            exitTicks = 0;
            FILETIME creationTime;
            FILETIME exitTime;
            FILETIME kernelTime;
            FILETIME userTime;
            if (!GetProcessTimes(Handle, out creationTime, out exitTime, out kernelTime, out userTime))
            {
                return false;
            }
            long fileTime = ((long)exitTime.High << 32) | exitTime.Low;
            if (fileTime == 0)
            {
                return WaitForSingleObject(Handle, 0) != WAIT_OBJECT_0;
            }
            exitTicks = DateTime.FromFileTimeUtc(fileTime).Ticks;
            return true;
        }

    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creationTime,
        out FILETIME exitTime,
        out FILETIME kernelTime,
        out FILETIME userTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr process,
        int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation,
        int processInformationLength,
        out int returnLength);

    private static HeldProcess OpenHeldProcess(uint processId, int depth)
    {
        bool ignored;
        return OpenHeldProcess(processId, depth, out ignored);
    }

    private static HeldProcess OpenHeldProcess(uint processId, int depth, out bool notFound)
    {
        notFound = false;
        IntPtr handle = OpenProcess(
            PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            false,
            processId);
        if (handle == IntPtr.Zero)
        {
            notFound = Marshal.GetLastWin32Error() == 87;
            return null;
        }
        FILETIME creationTime;
        FILETIME exitTime;
        FILETIME kernelTime;
        FILETIME userTime;
        PROCESS_BASIC_INFORMATION basic = new PROCESS_BASIC_INFORMATION();
        int returned;
        if (!GetProcessTimes(handle, out creationTime, out exitTime, out kernelTime, out userTime) ||
            NtQueryInformationProcess(handle, 0, ref basic, Marshal.SizeOf(basic), out returned) != 0)
        {
            notFound = WaitForSingleObject(handle, 0) == WAIT_OBJECT_0;
            CloseHandle(handle);
            return null;
        }
        long fileTime = ((long)creationTime.High << 32) | creationTime.Low;
        long creationTicks = DateTime.FromFileTimeUtc(fileTime).Ticks;
        return new HeldProcess(
            processId,
            unchecked((uint)basic.InheritedFromUniqueProcessId.ToInt64()),
            creationTicks,
            depth,
            handle);
    }

    private static Dictionary<uint, uint> SnapshotParents(out bool succeeded)
    {
        Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
        succeeded = false;
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE)
        {
            return parents;
        }
        try
        {
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.Size = (uint)Marshal.SizeOf(entry);
            if (!Process32FirstW(snapshot, ref entry))
            {
                return parents;
            }
            do
            {
                parents[entry.ProcessId] = entry.ParentProcessId;
                entry.Size = (uint)Marshal.SizeOf(entry);
            }
            while (Process32NextW(snapshot, ref entry));
            succeeded = true;
            return parents;
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    private static bool AssignToJob(IntPtr job, HeldProcess process)
    {
        bool alreadyAssigned;
        return (IsProcessInJob(process.Handle, job, out alreadyAssigned) && alreadyAssigned) ||
            AssignProcessToJobObject(job, process.Handle);
    }

    private static bool EnableKillOnJobClose(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(limits);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            return SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, buffer, (uint)size);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void RecordAncestry(
        Dictionary<uint, uint> parents,
        Dictionary<uint, HashSet<uint>> ancestryParents)
    {
        foreach (KeyValuePair<uint, uint> entry in parents)
        {
            HashSet<uint> knownParents;
            if (!ancestryParents.TryGetValue(entry.Key, out knownParents))
            {
                knownParents = new HashSet<uint>();
                ancestryParents.Add(entry.Key, knownParents);
            }
            knownParents.Add(entry.Value);
        }
    }

    private static bool HasPossibleHeldAncestor(
        uint processId,
        Dictionary<uint, HashSet<uint>> ancestryParents,
        Dictionary<uint, HeldProcess> held)
    {
        Queue<uint> pending = new Queue<uint>();
        HashSet<uint> seen = new HashSet<uint>();
        pending.Enqueue(processId);
        while (pending.Count > 0)
        {
            uint current = pending.Dequeue();
            if (!seen.Add(current))
            {
                continue;
            }
            HashSet<uint> parents;
            if (!ancestryParents.TryGetValue(current, out parents))
            {
                continue;
            }
            foreach (uint parent in parents)
            {
                if (held.ContainsKey(parent))
                {
                    return true;
                }
                pending.Enqueue(parent);
            }
        }
        return false;
    }

    private static int DiscoverDescendants(
        IntPtr job,
        Dictionary<uint, HeldProcess> held,
        Dictionary<uint, HashSet<uint>> ancestryParents,
        out bool incomplete)
    {
        bool snapshotSucceeded;
        Dictionary<uint, uint> parents = SnapshotParents(out snapshotSucceeded);
        int added = 0;
        incomplete = !snapshotSucceeded;
        if (!snapshotSucceeded)
        {
            return added;
        }
        RecordAncestry(parents, ancestryParents);
        bool progressed;
        do
        {
            progressed = false;
            foreach (KeyValuePair<uint, uint> entry in parents.ToArray())
            {
                if (held.ContainsKey(entry.Key))
                {
                    continue;
                }
                HeldProcess parent;
                if (!held.TryGetValue(entry.Value, out parent))
                {
                    continue;
                }
                bool candidateNotFound;
                HeldProcess candidate = OpenHeldProcess(entry.Key, parent.Depth + 1, out candidateNotFound);
                if (candidate == null)
                {
                    if (!candidateNotFound)
                    {
                        incomplete = true;
                    }
                    continue;
                }
                if (candidate.HasExited())
                {
                    candidate.Dispose();
                    continue;
                }
                long parentExitTicks;
                bool parentLifetimeKnown = parent.TryGetExitTicks(out parentExitTicks);
                if (
                    candidate.ParentProcessId != parent.ProcessId ||
                    candidate.CreationTicks < parent.CreationTicks ||
                    !parentLifetimeKnown ||
                    (parentExitTicks != 0 && candidate.CreationTicks > parentExitTicks))
                {
                    candidate.Dispose();
                    incomplete = true;
                    continue;
                }
                if (!AssignToJob(job, candidate))
                {
                    bool candidateExited = candidate.HasExited();
                    candidate.Dispose();
                    if (!candidateExited)
                    {
                        incomplete = true;
                    }
                    continue;
                }
                held.Add(candidate.ProcessId, candidate);
                added++;
                progressed = true;
            }
        }
        while (progressed);
        foreach (KeyValuePair<uint, uint> entry in parents)
        {
            if (held.ContainsKey(entry.Key) || !HasPossibleHeldAncestor(entry.Key, ancestryParents, held))
            {
                continue;
            }
            bool candidateNotFound;
            HeldProcess unverified = OpenHeldProcess(entry.Key, 0, out candidateNotFound);
            if (unverified != null)
            {
                bool candidateExited = unverified.HasExited();
                unverified.Dispose();
                if (!candidateExited)
                {
                    incomplete = true;
                }
            }
            else if (!candidateNotFound)
            {
                incomplete = true;
            }
        }
        return added;
    }

    private static int AddTrackedProcesses(
        string trackedProcessesText,
        IntPtr job,
        Dictionary<uint, HeldProcess> held)
    {
        if (String.IsNullOrWhiteSpace(trackedProcessesText))
        {
            return 0;
        }
        foreach (string trackedText in trackedProcessesText.Split(','))
        {
            string[] fields = trackedText.Split(':');
            uint trackedProcessId;
            long trackedCreationTicks;
            if (fields.Length != 2 ||
                !UInt32.TryParse(fields[0], out trackedProcessId) ||
                !Int64.TryParse(fields[1], out trackedCreationTicks))
            {
                return 4;
            }
            HeldProcess existing;
            if (held.TryGetValue(trackedProcessId, out existing))
            {
                if (existing.CreationTicks != trackedCreationTicks)
                {
                    continue;
                }
                continue;
            }
            bool trackedNotFound;
            HeldProcess tracked = OpenHeldProcess(trackedProcessId, 0, out trackedNotFound);
            if (tracked == null)
            {
                if (trackedNotFound)
                {
                    continue;
                }
                return 4;
            }
            if (tracked.CreationTicks != trackedCreationTicks)
            {
                tracked.Dispose();
                continue;
            }
            if (tracked.HasExited())
            {
                tracked.Dispose();
                continue;
            }
            if (!AssignToJob(job, tracked))
            {
                bool trackedExited = tracked.HasExited();
                tracked.Dispose();
                if (!trackedExited)
                {
                    return 4;
                }
                continue;
            }
            held.Add(tracked.ProcessId, tracked);
        }
        return 0;
    }

    public static int Terminate(
        string processIdText,
        string expectedCreationTicksText,
        string trackedProcessesText)
    {
        uint processId;
        long expectedCreationTicks;
        if (!UInt32.TryParse(processIdText, out processId) ||
            !Int64.TryParse(expectedCreationTicksText, out expectedCreationTicks))
        {
            return 4;
        }
        bool rootNotFound;
        Dictionary<uint, HeldProcess> held = new Dictionary<uint, HeldProcess>();
        bool rootIdentityMismatch = false;
        HeldProcess root = OpenHeldProcess(processId, 0, out rootNotFound);
        if (root == null && !rootNotFound)
        {
            return 4;
        }
        if (root != null && root.CreationTicks != expectedCreationTicks)
        {
            root.Dispose();
            root = null;
            rootIdentityMismatch = true;
        }
        if (root != null && root.HasExited())
        {
            root.Dispose();
            root = null;
            rootNotFound = true;
        }
        if (root != null)
        {
            held.Add(root.ProcessId, root);
        }
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            if (root != null)
            {
                root.Dispose();
            }
            return 4;
        }
        try
        {
            if (root != null && !AssignToJob(job, root))
            {
                return 4;
            }
            if (AddTrackedProcesses(trackedProcessesText, job, held) != 0)
            {
                return 4;
            }
            if (held.Count == 0)
            {
                return rootIdentityMismatch ? 3 : 2;
            }
            Dictionary<uint, HashSet<uint>> ancestryParents = new Dictionary<uint, HashSet<uint>>();
            bool discoveryIncomplete;
            DiscoverDescendants(job, held, ancestryParents, out discoveryIncomplete);
            int stablePasses = 0;
            for (int pass = 0; pass < 8 && stablePasses < 2; pass++)
            {
                Thread.Sleep(25);
                bool passIncomplete;
                stablePasses = DiscoverDescendants(job, held, ancestryParents, out passIncomplete) == 0 ? stablePasses + 1 : 0;
                discoveryIncomplete = discoveryIncomplete || passIncomplete;
            }
            if (discoveryIncomplete || stablePasses < 2 || !EnableKillOnJobClose(job))
            {
                return 4;
            }
            if (!CloseHandle(job))
            {
                return 4;
            }
            job = IntPtr.Zero;
            DateTime waitDeadline = DateTime.UtcNow.AddSeconds(10);
            foreach (HeldProcess process in held.Values)
            {
                double remainingMilliseconds = (waitDeadline - DateTime.UtcNow).TotalMilliseconds;
                if (remainingMilliseconds <= 0 ||
                    WaitForSingleObject(process.Handle, (uint)Math.Ceiling(remainingMilliseconds)) != WAIT_OBJECT_0)
                {
                    return 4;
                }
            }
            return rootIdentityMismatch ? 3 : 0;
        }
        finally
        {
            if (job != IntPtr.Zero)
            {
                CloseHandle(job);
            }
            foreach (HeldProcess process in held.Values)
            {
                process.Dispose();
            }
        }
    }
}
`;

export type WindowsProcessTreeTerminationResult = "terminated" | "not-found" | "identity-mismatch" | "failed";

export type UnixProcessGroupTerminationResult = "terminated" | "not-found" | "identity-mismatch" | "failed";

export interface UnixTrackedProcessIdentity {
	pid: number;
	processStartId: string;
}

export type UnixProcessSessionInspectionResult =
	| { status: "active"; members: UnixTrackedProcessIdentity[] }
	| { status: "not-found" | "identity-mismatch" | "failed"; members: [] };

interface UnixProcessGroupMember {
	pid: number;
	parentPid: number;
	processGroupId: number;
	sessionId: number;
}

type ProcessStartIdLookup = (pid: number) => string | undefined;
type UnixDetachedSessionLookupResult = UnixProcessGroupMember[] | "not-found" | "identity-mismatch" | "failed";

function snapshotUnixProcessGroups(): UnixProcessGroupMember[] | undefined {
	for (const sessionColumn of ["sid=", "sess="] as const) {
		const result = spawnSync("ps", ["-axo", `pid=,ppid=,pgid=,${sessionColumn}`], {
			encoding: "utf8",
			windowsHide: true,
		});
		if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
			continue;
		}
		const members: UnixProcessGroupMember[] = [];
		let valid = true;
		for (const line of result.stdout.split("\n")) {
			const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/u);
			if (!match) {
				if (line.trim()) valid = false;
				continue;
			}
			members.push({
				pid: Number.parseInt(match[1]!, 10),
				parentPid: Number.parseInt(match[2]!, 10),
				processGroupId: Number.parseInt(match[3]!, 10),
				sessionId: Number.parseInt(match[4]!, 10),
			});
		}
		if (valid) return members;
	}
	return undefined;
}

function unixDetachedSessionMembers(
	pid: number,
	expectedProcessStartId: string,
	lookupProcessStartId: ProcessStartIdLookup,
): UnixDetachedSessionLookupResult {
	const observedProcessStartId = lookupProcessStartId(pid);
	if (observedProcessStartId !== undefined && observedProcessStartId !== expectedProcessStartId) {
		return "identity-mismatch";
	}
	if (observedProcessStartId === undefined && processIdExists(pid)) {
		return "failed";
	}
	const snapshot = snapshotUnixProcessGroups();
	if (!snapshot) {
		return "failed";
	}
	const members = snapshot.filter((entry) => entry.sessionId === pid);
	if (observedProcessStartId === expectedProcessStartId) {
		const leader = members.find((entry) => entry.pid === pid);
		if (!leader || leader.processGroupId !== pid) {
			return "failed";
		}
	} else if (members.length === 0) {
		return "not-found";
	}
	return members;
}

export function inspectUnixProcessSessionByIdentity(
	pid: number,
	expectedProcessStartId: string,
	lookupProcessStartId: ProcessStartIdLookup,
): UnixProcessSessionInspectionResult {
	if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0 || !expectedProcessStartId) {
		return { status: "failed", members: [] };
	}
	let members = unixDetachedSessionMembers(pid, expectedProcessStartId, lookupProcessStartId);
	for (let attempt = 0; attempt < 3; attempt++) {
		if (!Array.isArray(members)) {
			return { status: members, members: [] };
		}
		const captured = new Map<number, string>();
		for (const member of members) {
			const processStartId = lookupProcessStartId(member.pid);
			if (processStartId !== undefined) {
				captured.set(member.pid, processStartId);
			} else if (processIdExists(member.pid)) {
				return { status: "failed", members: [] };
			}
		}
		const verified = unixDetachedSessionMembers(pid, expectedProcessStartId, lookupProcessStartId);
		if (!Array.isArray(verified)) {
			return { status: verified, members: [] };
		}
		const stable: UnixTrackedProcessIdentity[] = [];
		let changed = captured.size !== verified.length;
		for (const member of verified) {
			const observedProcessStartId = lookupProcessStartId(member.pid);
			if (observedProcessStartId === undefined) {
				if (processIdExists(member.pid)) {
					return { status: "failed", members: [] };
				}
				changed = true;
				continue;
			}
			if (captured.get(member.pid) !== observedProcessStartId) {
				changed = true;
				continue;
			}
			stable.push({ pid: member.pid, processStartId: observedProcessStartId });
		}
		if (!changed) {
			return stable.length > 0 ? { status: "active", members: stable } : { status: "not-found", members: [] };
		}
		members = verified;
	}
	return { status: "failed", members: [] };
}

/**
 * Terminate the detached Unix process group originally led by `pid`.
 *
 * A missing leader is not enough to declare success: the kernel keeps its
 * original session id on surviving descendants, including descendants that
 * created another process group. The session id can only be reused by a new
 * leader with the captured pid, whose process-start identity is checked before
 * any group-wide signal is sent.
 */
export async function terminateUnixProcessGroupByIdentity(
	pid: number,
	expectedProcessStartId: string,
	lookupProcessStartId: ProcessStartIdLookup,
): Promise<UnixProcessGroupTerminationResult> {
	if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0 || !expectedProcessStartId) {
		return "failed";
	}
	let members = unixDetachedSessionMembers(pid, expectedProcessStartId, lookupProcessStartId);
	if (!Array.isArray(members)) {
		return members;
	}
	// Re-read the process identity and group/session membership immediately
	// before signaling. A recycled leader always has a different start id.
	members = unixDetachedSessionMembers(pid, expectedProcessStartId, lookupProcessStartId);
	if (!Array.isArray(members)) {
		return members;
	}
	const deadline = Date.now() + 2000;
	while (true) {
		const observedProcessStartId = lookupProcessStartId(pid);
		if (observedProcessStartId !== undefined && observedProcessStartId !== expectedProcessStartId) {
			// Never follow a replacement leader. A surviving session member means
			// cleanup is incomplete and must remain journaled for exact recovery.
			const remaining = snapshotUnixProcessGroups();
			if (!remaining) {
				return "failed";
			}
			return remaining.some((entry) => entry.sessionId === pid) ? "failed" : "terminated";
		}
		if (observedProcessStartId === undefined && processIdExists(pid)) {
			return "failed";
		}
		members = unixDetachedSessionMembers(pid, expectedProcessStartId, lookupProcessStartId);
		if (!Array.isArray(members)) {
			return members === "identity-mismatch" ? "failed" : members;
		}
		if (members.length === 0) {
			return "terminated";
		}
		const processGroupIds = new Set(members.map((member) => member.processGroupId));
		if ([...processGroupIds].some((processGroupId) => processGroupId <= 0)) {
			return "failed";
		}
		for (const processGroupId of processGroupIds) {
			try {
				process.kill(-processGroupId, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
					return "failed";
				}
			}
		}
		if (Date.now() >= deadline) {
			return "failed";
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
}

export interface WindowsTrackedProcessIdentity {
	pid: number;
	processStartId: string;
}

export const WINDOWS_POWERSHELL_EXECUTABLES = ["pwsh.exe", "powershell.exe"] as const;
const WINDOWS_EXACT_TREE_HELPER_TIMEOUT_MS = 30_000;

export async function terminateWindowsProcessTreeByIdentity(
	pid: number,
	expectedProcessStartId: string,
	trackedProcesses: readonly WindowsTrackedProcessIdentity[] = [],
): Promise<WindowsProcessTreeTerminationResult> {
	if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
		return "failed";
	}
	const match = expectedProcessStartId.match(/^win:(\d+)$/u);
	if (!match) {
		return "failed";
	}
	const tracked: string[] = [];
	for (const processIdentity of trackedProcesses) {
		if (!Number.isInteger(processIdentity.pid) || processIdentity.pid <= 0) {
			return "failed";
		}
		const trackedMatch = processIdentity.processStartId.match(/^win:(\d+)$/u);
		if (!trackedMatch) {
			return "failed";
		}
		tracked.push(`${processIdentity.pid}:${trackedMatch[1]}`);
	}
	const command = `Add-Type -TypeDefinition @'\n${WINDOWS_EXACT_TREE_TERMINATION_SOURCE}\n'@\nexit [PrimeAgentProcessTree]::Terminate('${pid}', '${match[1]}', '${tracked.join(",")}')`;
	for (const executable of WINDOWS_POWERSHELL_EXECUTABLES) {
		const result = await new Promise<{ error?: Error; status: number | null }>((resolveResult) => {
			const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
				stdio: "ignore",
				windowsHide: true,
			});
			let settled = false;
			const timeout = setTimeout(() => {
				settle({ status: null });
				child.kill("SIGKILL");
				child.unref();
			}, WINDOWS_EXACT_TREE_HELPER_TIMEOUT_MS);
			const settle = (value: { error?: Error; status: number | null }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolveResult(value);
			};
			child.once("error", (error) => settle({ error, status: null }));
			child.once("close", (status) => settle({ status }));
		});
		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			continue;
		}
		if (result.error) {
			return "failed";
		}
		switch (result.status) {
			case 0:
				return "terminated";
			case 2:
				return "not-found";
			case 3:
				return "identity-mismatch";
			default:
				return "failed";
		}
	}
	return "failed";
}

const WINDOWS_SHELL_COMMANDS = new Set(["npm", "npx", "pnpm", "yarn", "yarnpkg", "corepack"]);

export function shouldUseWindowsShell(command: string): boolean {
	if (process.platform !== "win32") return false;
	const commandName = basename(command).toLowerCase();
	return commandName.endsWith(".cmd") || commandName.endsWith(".bat") || WINDOWS_SHELL_COMMANDS.has(commandName);
}

export interface PreparedWindowsCommand {
	command: string;
	args: string[];
	windowsVerbatimArguments?: boolean;
}

const WINDOWS_COMMAND_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/gu;
const WINDOWS_COMMAND_SHIM_PATTERN = /\.(?:cmd|bat)$/iu;

function escapeWindowsCommand(command: string): string {
	return command.replace(WINDOWS_COMMAND_META_CHARACTERS, "^$1");
}

function escapeWindowsCommandArgument(argument: string, doubleEscapeMetaCharacters: boolean): string {
	let escaped = argument.replace(/(?=(\\+?)?)\1"/gu, '$1$1\\"');
	escaped = escaped.replace(/(?=(\\+?)?)\1$/gu, "$1$1");
	escaped = `"${escaped}"`.replace(WINDOWS_COMMAND_META_CHARACTERS, "^$1");
	return doubleEscapeMetaCharacters ? escaped.replace(WINDOWS_COMMAND_META_CHARACTERS, "^$1") : escaped;
}

export function prepareWindowsShellCommand(command: string, args: readonly string[]): PreparedWindowsCommand {
	if (!shouldUseWindowsShell(command)) {
		return { command, args: [...args] };
	}
	const normalizedCommand = normalize(command);
	const doubleEscapeMetaCharacters =
		WINDOWS_COMMAND_SHIM_PATTERN.test(normalizedCommand) ||
		WINDOWS_SHELL_COMMANDS.has(basename(normalizedCommand).toLowerCase());
	const shellCommand = [
		escapeWindowsCommand(normalizedCommand),
		...args.map((argument) => escapeWindowsCommandArgument(argument, doubleEscapeMetaCharacters)),
	].join(" ");
	return {
		command: process.env.ComSpec ?? "cmd.exe",
		args: ["/d", "/s", "/c", `"${shellCommand}"`],
		windowsVerbatimArguments: true,
	};
}

/** Cheap kill(0) existence probe; counts zombies as existing. */
export function processIdExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A zombie has already exited; it only lingers until its parent reaps it. */
export function isZombieProcess(pid: number): boolean {
	if (process.platform === "win32") {
		return false;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trimStart()
			.charAt(0);
		return state === "Z";
	} catch {
		// Fall through to the portable process listing used on macOS and BSD.
	}
	try {
		const state = execFileSyncHidden("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
		return state.startsWith("Z");
	} catch {
		return false;
	}
}

/** True only for a process that is actually running: zombies do not count. */
export function isProcessAlive(pid: number): boolean {
	return processIdExists(pid) && !isZombieProcess(pid);
}

/** True while the group has any member left, zombies included; a group can outlive its leader. */
export function processGroupExists(pgid: number): boolean {
	if (process.platform === "win32") {
		return false;
	}
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** True while the group has a RUNNING member; unreaped zombies have exited and must not block a group stop. */
export function processGroupHasLiveMember(pgid: number): boolean {
	if (!processGroupExists(pgid)) {
		return false;
	}
	try {
		const listing = execFileSyncHidden("ps", ["-A", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" });
		for (const line of listing.split("\n")) {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 2) continue;
			if (Number(fields[0]) === pgid && !fields[1]!.startsWith("Z")) {
				return true;
			}
		}
		return false;
	} catch {
		// Unverifiable listing reads alive: callers keep escalating instead of dropping records over live descendants.
		return true;
	}
}

/**
 * Signal the group only while it is provably still the target: the leader process (even a zombie)
 * anchors its pgid against reuse; once the leader is gone, a live member must hold the pgid at
 * signal time, narrowing reuse exposure to the inherent kill() TOCTOU of any single-pid signal.
 */
export function signalProcessGroupIfHeld(pgid: number, signal: NodeJS.Signals): boolean {
	if (!processIdExists(pgid) && !processGroupHasLiveMember(pgid)) {
		return false;
	}
	signalProcessGroupOrProcess(pgid, signal);
	return true;
}

export function signalProcessGroupOrProcess(pid: number, signal: NodeJS.Signals): boolean {
	if (process.platform === "win32") {
		const result = spawnSyncHidden("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
			stdio: "ignore",
			timeout: 5000,
		});
		if (!result.error && result.status === 0) {
			return true;
		}
		// A failed tree kill gives no proof that descendants exited. A root-only
		// fallback, including treating ESRCH as success, would discard the journal
		// needed by the later identity-aware cleanup path.
		return false;
	}
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		// Fall back when process groups are unavailable or the group already exited.
	}
	try {
		process.kill(pid, signal);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * On Windows, daemonized descendants can inherit the child's stdout/stderr pipe
 * handles. In that case the child emits `exit`, but `close` can hang forever even
 * though the original process is already gone. We wait briefly for stdio to end,
 * then forcibly stop tracking the inherited handles.
 */
function signalExitCode(signal: NodeJS.Signals | null): number | null {
	if (!signal) return null;
	const signalNumber = constants.signals[signal];
	return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function normalizedExitCode(code: number | null, signal: NodeJS.Signals | null): number | null {
	return code ?? signalExitCode(signal);
}

export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null || child.stdout.readableEnded;
		let stderrEnded = child.stderr === null || child.stderr.readableEnded;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(normalizedExitCode(exitCode, exitSignal));
			}
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalizeAfterExit();
			if (!settled) {
				postExitTimer = setTimeout(() => finalize(normalizedExitCode(code, signal)), EXIT_STDIO_GRACE_MS);
			}
		};

		const onClose = (code: number | null, signal: NodeJS.Signals | null = null) => {
			finalize(normalizedExitCode(code, signal));
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);

		if (child.exitCode !== null || child.signalCode !== null) {
			onExit(child.exitCode, child.signalCode);
		}
	});
}
