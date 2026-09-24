import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { childEnvironment } from './git-env.js';
import {
  collectExit,
  DEFAULT_STDOUT_BYTES,
  type GroupExit,
  type LaunchInGroupOptions,
  type ProcessGroup,
  type Quarantine,
  type QuarantineSurvivor,
  type QuarantineSurvivors,
  type TerminateResult,
} from './process-group.js';

// PLAN-13-R2 §2.2: on Windows the only mechanism is a named job object. A small PowerShell
// launcher compiles (once, cached by a hash of the source) a C# helper with the Win32 calls,
// creates the job with `KILL_ON_JOB_CLOSE` and no `BREAKAWAY_OK`, starts the child suspended,
// assigns it to the job and only then lets it run. The job handle is never inherited: the
// child cannot walk out. Al terminar el hijo o al recibir `kill`, the launcher calls
// `TerminateJobObject` and waits until `QueryInformationJobObject` reports zero active
// processes. The launcher writes nothing to its own stdout/stderr — those belong to the child.
//
// The C# source lives here as text and is cached in `os.tmpdir()`; the recipe is never
// edited to add files to the published package.

const LAUNCHER_SOURCE = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;

namespace AiWorkflows {
  public static class Native {
    private static volatile bool killRequested;
    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO {
      public int cb;
      public IntPtr lpReserved;
      public IntPtr lpDesktop;
      public IntPtr lpTitle;
      public int dwX;
      public int dwY;
      public int dwXSize;
      public int dwYSize;
      public int dwXCountChars;
      public int dwYCountChars;
      public int dwFillAttribute;
      public int dwFlags;
      public short wShowWindow;
      public short cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public int dwProcessId;
      public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
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
    public struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
      public long TotalUserTime;
      public long TotalKernelTime;
      public long ThisPeriodTotalUserTime;
      public long ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount;
      public uint TotalProcesses;
      public uint ActiveProcesses;
      public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returned);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr process, uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(string application, System.Text.StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int which);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);

    public static IntPtr CreateJob(string name) {
      IntPtr job = CreateJobObject(IntPtr.Zero, name);
      if (job == IntPtr.Zero) return IntPtr.Zero;
      int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr info = Marshal.AllocHGlobal(size);
      try {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = 0x00002000;
        Marshal.StructureToPtr(limits, info, false);
        if (!SetInformationJobObject(job, 9, info, (uint)size)) {
          CloseHandle(job);
          return IntPtr.Zero;
        }
        return job;
      } finally {
        Marshal.FreeHGlobal(info);
      }
    }

    public static uint ActiveProcesses(IntPtr job) {
      int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      IntPtr info = Marshal.AllocHGlobal(size);
      try {
        uint returned;
        if (!QueryInformationJobObject(job, 1, info, (uint)size, out returned)) return 4294967295u;
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION account = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(info, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        return account.ActiveProcesses;
      } finally {
        Marshal.FreeHGlobal(info);
      }
    }

    public static IntPtr OpenJob(string name) {
      IntPtr job = OpenJobObject(4u, false, name);
      if (job == IntPtr.Zero) openJobError = Marshal.GetLastWin32Error();
      return job;
    }

    public static int openJobError = 0;

    /**
     * The pids still assigned to the job, each with the process's creation time as FILETIME UTC
     * text, so a reused pid is told apart. Read after a failed terminate: the launcher names
     * exactly what it could not end. A query that fails returns null, never an empty array, so
     * "could not list" is not read as "nothing left".
     */
    public static string[] Survivors(IntPtr job) {
      int header = 8;
      int capacity = 1024;
      IntPtr info = Marshal.AllocHGlobal(header + capacity * IntPtr.Size);
      try {
        uint returned;
        if (!QueryInformationJobObject(job, 3, info, (uint)(header + capacity * IntPtr.Size), out returned)) {
          return null;
        }
        uint count = (uint)Marshal.ReadInt32(info, 4);
        if (count > (uint)capacity) count = (uint)capacity;
        List<string> found = new List<string>();
        for (int i = 0; i < count; i++) {
          IntPtr slot = new IntPtr(info.ToInt64() + header + i * IntPtr.Size);
          long pid = Marshal.ReadIntPtr(slot).ToInt64();
          if (pid <= 0) continue;
          // Never 0: a creation time that could not be read is "unknown", so the reader keeps
          // the quarantine instead of taking the pid as gone.
          string created = "unknown";
          try { created = Process.GetProcessById((int)pid).StartTime.ToFileTimeUtc().ToString(); } catch (Exception) { }
          found.Add(pid.ToString() + ":" + created);
        }
        return found.ToArray();
      } finally {
        Marshal.FreeHGlobal(info);
      }
    }

    public static IntPtr OpenInheritable(string path) {
      IntPtr handle = CreateFile(path, 2147483648u, 3u, IntPtr.Zero, 3u, 128u, IntPtr.Zero);
      if (handle == new IntPtr(-1)) return IntPtr.Zero;
      SetHandleInformation(handle, 1u, 1u);
      return handle;
    }

    public static uint RunToEnd(IntPtr job, IntPtr process) {
      killRequested = false;
      Thread reader = new Thread(delegate() {
        try {
          StreamReader input = new StreamReader(Console.OpenStandardInput());
          string line;
          while ((line = input.ReadLine()) != null) {
            if (line.Trim() == "kill") { killRequested = true; break; }
          }
        } catch (Exception) { }
      });
      reader.IsBackground = true;
      reader.Start();

      while (true) {
        if (killRequested) break;
        if (WaitForSingleObject(process, 100) == 0) break;
      }

      TerminateJobObject(job, 1);
      Stopwatch clock = Stopwatch.StartNew();
      uint active = 1;
      while (clock.ElapsedMilliseconds < 10000) {
        active = ActiveProcesses(job);
        if (active == 0) break;
        Thread.Sleep(50);
      }
      return active;
    }

    public static bool Launch(string application, string commandLine, string cwd, IntPtr stdin, IntPtr stdout, IntPtr stderr, IntPtr job, out IntPtr process, out int processId) {
      // The child must never see the launcher's own variables (the job name, the result path):
      // they are cleared from this process before CreateProcess inherits its environment. Only
      // the launcher's own names are removed — anything else named AIW_ belongs to the
      // project and travels to the child untouched.
      string[] own = new string[] {
        "AIW_MODE", "AIW_JOB", "AIW_RESULT", "AIW_STDIN", "AIW_APP",
        "AIW_CMDLINE", "AIW_CWD", "AIW_ASSEMBLY", "AIW_SOURCE_FILE"
      };
      foreach (string key in own) {
        Environment.SetEnvironmentVariable(key, null);
      }
      STARTUPINFO startup = new STARTUPINFO();
      startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      startup.dwFlags = 256;
      startup.hStdInput = stdin;
      startup.hStdOutput = stdout;
      startup.hStdError = stderr;
      PROCESS_INFORMATION created;
      System.Text.StringBuilder line = new System.Text.StringBuilder(commandLine);
      bool ok = CreateProcess(application, line, IntPtr.Zero, IntPtr.Zero, true, 4u, IntPtr.Zero, cwd, ref startup, out created);
      if (!ok) {
        process = IntPtr.Zero;
        processId = 0;
        return false;
      }
      if (!AssignProcessToJobObject(job, created.hProcess)) {
        // The child is still suspended and cannot be in the job, so it would never be killed
        // with the group. End it here and report a technical failure; no process is left loose.
        TerminateProcess(created.hProcess, 1);
        CloseHandle(created.hThread);
        CloseHandle(created.hProcess);
        process = IntPtr.Zero;
        processId = 0;
        return false;
      }
      ResumeThread(created.hThread);
      CloseHandle(created.hThread);
      process = created.hProcess;
      processId = created.dwProcessId;
      return true;
    }
  }
}
`;

const LAUNCHER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

$mode = $env:AIW_MODE
$result = $env:AIW_RESULT

try {
  $cache = $env:AIW_ASSEMBLY
  $loaded = $false
  if (Test-Path -LiteralPath $cache) {
    try { Add-Type -Path $cache -ErrorAction Stop; $loaded = $true } catch { $loaded = $false }
  }
  if (-not $loaded) {
    # Compile to a name of our own and move it into place atomically. If another process left
    # the assembly first, its copy is used; a leftover of a lost race is never read as a name.
    $source = [System.IO.File]::ReadAllText($env:AIW_SOURCE_FILE)
    $dir = [System.IO.Path]::GetDirectoryName($cache)
    $compiled = Join-Path $dir ("aiw-launcher-" + [guid]::NewGuid().ToString() + ".dll")
    Add-Type -TypeDefinition $source -OutputAssembly $compiled -ErrorAction Stop
    try { Move-Item -LiteralPath $compiled -Destination $cache -Force -ErrorAction Stop } catch { }
    $fromCache = $false
    try { Add-Type -Path $cache -ErrorAction Stop; $fromCache = $true } catch { $fromCache = $false }
    if ($fromCache) {
      if (Test-Path -LiteralPath $compiled) { Remove-Item -LiteralPath $compiled -Force -ErrorAction SilentlyContinue }
    } else {
      if (Test-Path -LiteralPath $compiled) {
        Add-Type -Path $compiled -ErrorAction Stop
      } else {
        $compiled = Join-Path $dir ("aiw-launcher-" + [guid]::NewGuid().ToString() + ".dll")
        Add-Type -TypeDefinition $source -OutputAssembly $compiled -ErrorAction Stop
        Add-Type -Path $compiled -ErrorAction Stop
      }
    }
  }

  # Best effort: drop temporary launcher assemblies older than a day. They are only leftovers
  # of a lost race, never the cached one (whose name starts with "ai-workflows-").
  try {
    $launcherDir = [System.IO.Path]::GetDirectoryName($env:AIW_ASSEMBLY)
    Get-ChildItem -LiteralPath $launcherDir -Filter 'aiw-launcher-*.dll' -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
      Remove-Item -Force -ErrorAction SilentlyContinue
  } catch { }

  if ($mode -eq 'check') {
    $job = [AiWorkflows.Native]::OpenJob($env:AIW_JOB)
    if ($job -eq [IntPtr]::Zero) {
      $code = [AiWorkflows.Native]::openJobError
      # Only "no such job" means the group is gone: a job with KILL_ON_JOB_CLOSE disappears
      # once its owner ended and every process is gone. Any other error (denied, invalid or
      # oversized name) is an answer we do not have, so the quarantine must hold.
      if ($code -eq 2) {
        [System.IO.File]::WriteAllText($result, '{"empty":true}')
      } else {
        [System.IO.File]::WriteAllText($result, ('{"empty":false,"openError":' + $code + '}'))
      }
      exit 0
    }
    $active = [AiWorkflows.Native]::ActiveProcesses($job)
    [void][AiWorkflows.Native]::CloseHandle($job)
    if ($active -eq 0) { [System.IO.File]::WriteAllText($result, '{"empty":true}') }
    else { [System.IO.File]::WriteAllText($result, '{"empty":false}') }
    exit 0
  }

  $jobName = $env:AIW_JOB
  $application = $env:AIW_APP
  $commandLine = $env:AIW_CMDLINE
  $childCwd = $env:AIW_CWD
  $stdinPath = $env:AIW_STDIN

  $job = [AiWorkflows.Native]::CreateJob($jobName)
  if ($job -eq [IntPtr]::Zero) {
    [System.IO.File]::WriteAllText($result, '{"error":"could not create the job object"}')
    exit 0
  }
  $stdin = [AiWorkflows.Native]::OpenInheritable($stdinPath)
  $out = [AiWorkflows.Native]::GetStdHandle(-11)
  $err = [AiWorkflows.Native]::GetStdHandle(-12)
  [void][AiWorkflows.Native]::SetHandleInformation($out, 1, 1)
  [void][AiWorkflows.Native]::SetHandleInformation($err, 1, 1)
  $process = [IntPtr]::Zero
  $childPid = 0
  $ok = [AiWorkflows.Native]::Launch($application, $commandLine, $childCwd, $stdin, $out, $err, $job, [ref]$process, [ref]$childPid)
  if ($stdin -ne [IntPtr]::Zero) { [void][AiWorkflows.Native]::CloseHandle($stdin) }
  if (-not $ok) {
    [System.IO.File]::WriteAllText($result, '{"error":"could not start the process"}')
    exit 0
  }

  # C# waits for the child or for a kill order on standard input, terminates the whole job
  # and confirms zero active processes. PowerShell's own ReadLineAsync blocks here, so the
  # read lives on a real background thread inside the helper.
  $active = [AiWorkflows.Native]::RunToEnd($job, $process)
  $code = 0
  [void][AiWorkflows.Native]::GetExitCodeProcess($process, [ref]$code)
  $empty = 'false'
  if ($active -eq 0) { $empty = 'true' }
  # A list that could not be read is "null", never "[]": the reader must tell them apart.
  $survivors = 'null'
  if ($active -ne 0) {
    $listed = [AiWorkflows.Native]::Survivors($job)
    if ($null -ne $listed -and @($listed).Count -eq 0) {
      # The list came back empty: the job may have emptied between the wait and this read. Ask
      # the system again. Zero active processes means the tree really emptied; anything else
      # means the list could not be read, which the reader must not mistake for "no survivors".
      $again = [AiWorkflows.Native]::ActiveProcesses($job)
      if ($again -eq 0) { $empty = 'true' }
    } elseif ($null -ne $listed) {
      $entries = @()
      foreach ($pair in $listed) {
        $split = $pair.IndexOf(':')
        $pidText = $pair.Substring(0, $split)
        $createdText = $pair.Substring($split + 1)
        $entries += ('{"pid":' + $pidText + ',"created":"' + $createdText + '"}')
      }
      $survivors = '[' + ($entries -join ',') + ']'
    }
  }
  # The logon session is reported so a quarantine can tell a group of this session from one
  # that cannot be asked from here.
  $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  [System.IO.File]::WriteAllText($result, ('{"session":' + $session + ',"childExit":' + $code + ',"treeEmpty":' + $empty + ',"survivors":' + $survivors + '}'))
  exit 0
} catch {
  if ($result) {
    $message = ConvertTo-Json $_.Exception.Message -Compress
    [System.IO.File]::WriteAllText($result, ('{"error":' + $message + '}'))
  }
  exit 1
}
`;

const POWERSHELL = 'powershell.exe';

/**
 * How long Node waits for the launcher after a kill order. The launcher itself gives its job ten
 * seconds to empty, so Node's limit must be clearly longer; otherwise a working launcher is
 * mistaken for a lost one and its result folder is deleted while it is still writing.
 */
const LAUNCHER_SETTLE_MS = 25_000;

function encoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function powershellArgs(script: string): readonly string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded(script),
  ];
}

/** The assembly is cached by a hash of the C# source, so recompilation happens only on change. */
function sourceHash(): string {
  return createHash('sha256').update(LAUNCHER_SOURCE).digest('hex').slice(0, 16);
}

function sourcePath(): string {
  return join(tmpdir(), `ai-workflows-launcher-${sourceHash()}.cs`);
}

function assemblyPath(): string {
  return join(tmpdir(), `ai-workflows-launcher-${sourceHash()}.dll`);
}

function ensureSource(): void {
  // The cached `.cs` must be exactly today's source before its DLL is reused. A mismatch
  // (a corrupted file, or an older source under the same name) is rewritten and the assembly
  // it produced is dropped, so it is rebuilt rather than loaded as if it were current.
  const path = sourcePath();
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = undefined;
  }
  if (current === LAUNCHER_SOURCE) return;
  writeFileSync(path, LAUNCHER_SOURCE, 'utf8');
  try {
    rmSync(assemblyPath(), { force: true });
  } catch {
    // Another process is reading it; its own source check will rebuild when it can.
  }
}

/**
 * Quotes one argument by the rules `CommandLineToArgvW` reads back: backslashes before a
 * quote are doubled, the quote is escaped, and trailing backslashes are doubled. No console
 * is involved, so the child receives exactly these arguments.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/.test(argument)) return argument;
  let result = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1;
      result += '\\';
    } else if (character === '"') {
      result += '\\'.repeat(backslashes + 1);
      result += '"';
      backslashes = 0;
    } else {
      result += character;
      backslashes = 0;
    }
  }
  result += '\\'.repeat(backslashes);
  result += '"';
  return result;
}

interface Report {
  readonly childExit?: number;
  readonly treeEmpty?: boolean;
  readonly empty?: boolean;
  readonly error?: string;
  readonly openError?: number;
  readonly session?: number;
  /** The readable survivor list, or absent when the launcher could not list one. */
  readonly survivors?: readonly QuarantineSurvivor[];
}

function parseReport(raw: string): Report | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const survivors = readReportSurvivors(record['survivors']);
  return {
    ...(typeof record['childExit'] === 'number' ? { childExit: record['childExit'] } : {}),
    ...(typeof record['treeEmpty'] === 'boolean' ? { treeEmpty: record['treeEmpty'] } : {}),
    ...(typeof record['empty'] === 'boolean' ? { empty: record['empty'] } : {}),
    ...(typeof record['error'] === 'string' ? { error: record['error'] } : {}),
    ...(typeof record['openError'] === 'number' ? { openError: record['openError'] } : {}),
    ...(typeof record['session'] === 'number' ? { session: record['session'] } : {}),
    ...(survivors === undefined ? {} : { survivors }),
  };
}

function readReportText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readReport(file: string): Report | undefined {
  const raw = readReportText(file);
  return raw === undefined ? undefined : parseReport(raw);
}

/**
 * The survivor list a report carries, or `undefined` when there is no readable one. A missing,
 * empty or malformed list is unreadable, never "no survivors": the launcher reports `null` when
 * it could not list them, and a blank list while processes remain is just as unreadable.
 */
function readReportSurvivors(value: unknown): readonly QuarantineSurvivor[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const survivors: QuarantineSurvivor[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const record = item as Record<string, unknown>;
    const pid = record['pid'];
    const created = record['created'];
    if (!(typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof created === 'string')) {
      return undefined;
    }
    survivors.push({ pid, created });
  }
  return survivors;
}

function removeQuietly(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temporary folder is not a reason to fail the run.
  }
}

/**
 * Reads the launcher's answer to a kill order, or reports it lost. Only a launcher that ended
 * with 0 and left a readable report can answer: its own failure, a missing or unreadable report
 * and a report without a verdict (`treeEmpty` absent) are all "lost", never "empty". An
 * explicit `treeEmpty: false` is a fact and carries the survivors the launcher named.
 */
export function terminateResultFromReport(
  raw: string | undefined,
  launcherExit: number | null,
): TerminateResult {
  if (launcherExit !== 0) return { empty: false, lost: true };
  const report = typeof raw === 'string' ? parseReport(raw) : undefined;
  if (report === undefined) return { empty: false, lost: true };
  if (report.treeEmpty === true) return { empty: true };
  if (report.treeEmpty === false) {
    return { empty: false, survivors: report.survivors ?? 'unreadable' };
  }
  return { empty: false, lost: true };
}

/** The command's own output, as read by the engine's collector. */
export interface LauncherOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/**
 * Reads the launcher's answer after a wait. A group that was never confirmed empty, a lost
 * report, a launcher error and a report without the command's numeric exit code are all
 * technical: none of them can be read as a clean exit.
 */
export function groupExitFromReport(
  raw: string | undefined,
  launcherExit: number | null,
  output: LauncherOutput,
): GroupExit {
  if (launcherExit !== 0) {
    return { kind: 'technical', reason: 'the launcher did not end cleanly' };
  }
  const report = typeof raw === 'string' ? parseReport(raw) : undefined;
  if (report === undefined) {
    return { kind: 'technical', reason: 'the launcher did not report a result' };
  }
  if (typeof report.error === 'string') {
    return { kind: 'technical', reason: `the launcher reported an error: ${report.error}` };
  }
  if (report.treeEmpty !== true) {
    return { kind: 'technical', reason: 'the process group was not confirmed empty' };
  }
  if (typeof report.childExit !== 'number') {
    return { kind: 'technical', reason: 'the launcher did not report an exit code' };
  }
  return {
    kind: 'exited',
    code: report.childExit,
    stdout: output.stdout,
    stderr: output.stderr,
    truncated: output.truncated,
  };
}

export function launchWindowsGroup(options: LaunchInGroupOptions): ProcessGroup {
  const job = `Local\\ai-workflows-${randomUUID()}`;
  // The logon session is recorded when the group starts, not only once the launcher reports:
  // a quarantine must be askable from the very moment there may be something to ask about.
  let session = readWindowsSessionSync();
  const baseQuarantine: Quarantine = {
    host: hostname(),
    platform: 'win32',
    job,
    confirmed: false,
    ...(session === undefined ? {} : { session }),
  };
  let survivors: QuarantineSurvivors = [];
  const stdoutBytes = options.stdoutBytes ?? DEFAULT_STDOUT_BYTES;
  const directory = mkdtempSync(join(tmpdir(), 'aiw-group-'));
  const stdinFile = join(directory, 'stdin.txt');
  const resultFile = join(directory, 'result.json');
  writeFileSync(stdinFile, options.stdin, 'utf8');
  ensureSource();

  const application = options.command;
  const commandLine = [application, ...options.args].map(quoteWindowsArgument).join(' ');
  const environment: NodeJS.ProcessEnv = {
    // The agents' credentials never reach a child the piece runs (PLAN-13-R4 §8).
    ...(options.environment ?? childEnvironment()),
    ...(options.env ?? {}),
    AIW_MODE: 'launch',
    AIW_JOB: job,
    AIW_RESULT: resultFile,
    AIW_STDIN: stdinFile,
    AIW_APP: application,
    AIW_CMDLINE: commandLine,
    AIW_CWD: options.cwd,
    AIW_ASSEMBLY: assemblyPath(),
    AIW_SOURCE_FILE: sourcePath(),
  };

  const child = spawn(POWERSHELL, [...powershellArgs(LAUNCHER_SCRIPT)], {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: environment,
  });
  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});

  let launcherExit: number | null = null;
  const exited = new Promise<void>((resolve) => {
    child.on('close', (code) => {
      launcherExit = code;
      resolve();
    });
    child.on('error', () => resolve());
  });

  let terminatePromise: Promise<TerminateResult> | undefined;
  const doTerminate = async (): Promise<TerminateResult> => {
    try {
      child.stdin?.write('kill\n');
    } catch {
      // The launcher already ended; the result file still says whether the job emptied.
    }
    const timedOut = await new Promise<boolean>((resolve) => {
      // The launcher gives its own job ten seconds to empty; Node waits clearly longer, so a
      // launcher still working is never mistaken for one that died and its folder is not
      // deleted while it is still writing the answer.
      const timer = setTimeout(() => resolve(true), LAUNCHER_SETTLE_MS);
      timer.unref?.();
      void exited.then(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (timedOut) {
      // The launcher did not answer in time: its own answer is lost, so the system may be
      // asked again. Only now is the folder removed, with the launcher given up on.
      removeQuietly(directory);
      return { empty: false, lost: true };
    }
    const raw = readReportText(resultFile);
    const result = terminateResultFromReport(raw, launcherExit);
    const report = raw === undefined ? undefined : parseReport(raw);
    // A lost answer names nothing: the system is asked again. An explicit "not empty" without
    // a readable list is unreadable, so the quarantine keeps saying so.
    survivors =
      result.empty || result.lost === true ? [] : (result.survivors ?? 'unreadable');
    if (report?.session !== undefined) session = report.session;
    removeQuietly(directory);
    return result;
  };
  const terminate = (): Promise<TerminateResult> => (terminatePromise ??= doTerminate());

  const raw = collectExit(child, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    stdoutBytes,
    kill: () => void terminate(),
  });

  let waitPromise: Promise<GroupExit> | undefined;
  const wait = (): Promise<GroupExit> => {
    waitPromise ??= (async (): Promise<GroupExit> => {
      const value = await raw;
      if (value.startError !== undefined) {
        return { kind: 'technical', reason: `could not start ${application}: ${value.startError}` };
      }
      if (value.timedOut) {
        return { kind: 'technical', reason: `ran out of time after ${options.timeoutMs ?? 0} ms` };
      }
      if (value.overLimit) {
        return { kind: 'technical', reason: `printed more than ${stdoutBytes} bytes` };
      }
      const reportText = readReportText(resultFile);
      const report = reportText === undefined ? undefined : parseReport(reportText);
      if (report?.session !== undefined) session = report.session;
      return groupExitFromReport(reportText, launcherExit, {
        stdout: value.stdout,
        stderr: value.stderr,
        truncated: value.truncated,
      });
    })();
    return waitPromise;
  };

  return {
    get quarantine(): Quarantine {
      const base = session === undefined ? baseQuarantine : { ...baseQuarantine, session };
      if (survivors === 'unreadable') return { ...base, survivors: 'unreadable' };
      return survivors.length === 0 ? base : { ...base, survivors };
    },
    wait,
    terminate,
  };
}

/** A job name the system can be asked about: a plain object name, nothing more. */
const SAFE_JOB_NAME = /^[\\A-Za-z0-9._-]+$/;
const MAX_JOB_NAME_LENGTH = 256;

/**
 * Opens a job by name in the launcher's `check` mode and reads whether it is empty. A job with
 * `KILL_ON_JOB_CLOSE` only disappears once its owner ended and every process is gone, so a job
 * that no longer exists means nothing is left; one that exists is asked for its active count.
 * Windows denies terminating another process's job handle, so the check only asks. A name that
 * is empty, too long or not a plain object name is refused before the system is asked: an
 * unreadable answer must never be read as "empty".
 */
export async function checkWindowsQuarantine(job: string): Promise<{ empty: true } | { empty: false; reason: string }> {
  if (job.trim() === '' || job.length > MAX_JOB_NAME_LENGTH || !SAFE_JOB_NAME.test(job)) {
    return { empty: false, reason: `the job object "${job}" is not a name the system can look up` };
  }
  const directory = mkdtempSync(join(tmpdir(), 'aiw-check-'));
  const resultFile = join(directory, 'result.json');
  ensureSource();
  const child = spawn(POWERSHELL, [...powershellArgs(LAUNCHER_SCRIPT)], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      AIW_MODE: 'check',
      AIW_JOB: job,
      AIW_RESULT: resultFile,
      AIW_ASSEMBLY: assemblyPath(),
      AIW_SOURCE_FILE: sourcePath(),
    },
  });
  child.on('error', () => {});

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 15_000);
    timer.unref?.();
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const report = readReport(resultFile);
  removeQuietly(directory);
  if (report?.empty === true) return { empty: true };
  // An error other than "no such job" is an answer we do not have: it is reported by its code
  // rather than dressed up as "still has processes".
  if (typeof report?.openError === 'number') {
    return { empty: false, reason: `the job ${job} could not be checked: ${report.openError}` };
  }
  return { empty: false, reason: `the job object "${job}" still has processes` };
}

/** What can be said about the survivors a launcher named. */
export type SurvivorStatus = 'alive' | 'dead' | 'unknown';

/**
 * Whether the survivors the launcher named are alive, gone or unknowable. A single live one
 * makes the group alive; if none is alive but one could not be read (a PowerShell error or
 * timeout, a missing or malformed creation time, an unreadable pid) the answer is `unknown`, so
 * the quarantine holds. Only when every survivor is provably a different process is it `dead`,
 * and then the job name answers.
 */
export async function windowsSurvivorStatus(
  survivors: readonly QuarantineSurvivor[],
): Promise<SurvivorStatus> {
  if (survivors.length === 0) return 'dead';
  const states = await survivorStates(survivors);
  if (states.includes('alive')) return 'alive';
  return states.includes('unknown') ? 'unknown' : 'dead';
}

/**
 * Reads every survivor's state in ONE PowerShell call. Every answer line is labelled with the
 * pid it belongs to and matched by pid, never by position: a warning, a blank line or any other
 * stray output cannot shift the answers. A survivor that genuinely EXists but whose start time
 * cannot be read — a protected process, an access-denied, a null `StartTime` — is `unknown`,
 * never `dead`: only `Get-Process` not finding the process at all means it is gone. A survivor
 * recorded with `created: "unknown"` is checked by pid alone: gone is dead, still there is
 * unknown, because no creation time can be compared.
 */
async function survivorStates(
  survivors: readonly QuarantineSurvivor[],
): Promise<SurvivorStatus[]> {
  const states: SurvivorStatus[] = survivors.map(() => 'unknown');
  const askable: { readonly index: number; readonly pid: number; readonly created: string }[] = [];
  survivors.forEach((survivor, index) => {
    if (
      Number.isInteger(survivor.pid) &&
      survivor.pid > 0 &&
      (survivor.created === 'unknown' || /^\d+$/.test(survivor.created))
    ) {
      askable.push({ index, pid: survivor.pid, created: survivor.created });
    }
  });
  if (askable.length === 0) return states;

  // Both values come from the launcher itself; the guard keeps a repaired quarantine from
  // turning into a PowerShell injection anyway.
  const script = askable
    .map(({ pid, created }) =>
      created === 'unknown'
        ? `try { $null = Get-Process -Id ${pid} -ErrorAction Stop; '${pid}:exists' } catch { '${pid}:dead' }`
        : `try { $p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
          `$t = $null; try { $t = $p.StartTime.ToFileTimeUtc().ToString() } catch { }; ` +
          `if ($t -eq $null) { '${pid}:unknown' } ` +
          `elseif ($t -eq '${created}') { '${pid}:alive' } ` +
          `else { '${pid}:other' } } catch { '${pid}:dead' }`,
    )
    .join('\n');
  const output = await runPowershell(script);

  // Read the answers by pid, not by position. A line that is missing or unreadable leaves the
  // survivor unknown, which keeps the quarantine (running more is worse than blocking in excess).
  const answers = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+):([A-Za-z]+)\s*$/.exec(line);
    if (match === null) continue;
    const pid = Number.parseInt(match[1] as string, 10);
    const answer = match[2];
    if (answer !== undefined) answers.set(pid, answer);
  }

  askable.forEach(({ index, pid, created }) => {
    const answer = answers.get(pid);
    if (answer === 'alive') states[index] = 'alive';
    else if (answer === 'dead' || answer === 'other') states[index] = 'dead';
    // 'exists' with an unknown creation time, 'unknown' when the start time could not be read,
    // or no answer at all: unknown, never gone.
    else if (answer === 'exists' && created === 'unknown') states[index] = 'unknown';
    else states[index] = 'unknown';
  });
  return states;
}

/**
 * The logon session of this process, cached only when it could be read. A failure is never
 * remembered, so the next caller retries instead of inheriting an undefined answer for good.
 */
let cachedWindowsSession: number | undefined;

function parseSessionId(output: string): number | undefined {
  const value = Number.parseInt(output.trim(), 10);
  return Number.isInteger(value) ? value : undefined;
}

/**
 * The current session, read synchronously so a launch can put it in its quarantine from the
 * start, without waiting for the launcher's report. Cached on success, retried on failure.
 */
function readWindowsSessionSync(): number | undefined {
  if (cachedWindowsSession !== undefined) return cachedWindowsSession;
  try {
    const output = execFileSync(
      POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '[System.Diagnostics.Process]::GetCurrentProcess().SessionId',
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 15_000 },
    );
    const value = parseSessionId(output);
    if (value !== undefined) cachedWindowsSession = value;
    return value;
  } catch {
    return undefined;
  }
}

export async function currentWindowsSessionId(): Promise<number | undefined> {
  if (cachedWindowsSession !== undefined) return cachedWindowsSession;
  const output = await runPowershell(
    '[System.Diagnostics.Process]::GetCurrentProcess().SessionId',
  );
  const value = parseSessionId(output);
  if (value !== undefined) cachedWindowsSession = value;
  return value;
}

function runPowershell(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 15_000 },
      (error, stdout) => resolve(error === null ? (stdout ?? '') : ''),
    );
  });
}
