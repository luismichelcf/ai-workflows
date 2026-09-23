import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectExit,
  DEFAULT_STDOUT_BYTES,
  TERMINATE_TIMEOUT_MS,
  type GroupExit,
  type LaunchInGroupOptions,
  type ProcessGroup,
  type Quarantine,
  type QuarantineSurvivor,
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
     * exactly what it could not end.
     */
    public static string[] Survivors(IntPtr job) {
      int header = 8;
      int capacity = 1024;
      IntPtr info = Marshal.AllocHGlobal(header + capacity * IntPtr.Size);
      try {
        uint returned;
        if (!QueryInformationJobObject(job, 3, info, (uint)(header + capacity * IntPtr.Size), out returned)) {
          return new string[0];
        }
        uint count = (uint)Marshal.ReadInt32(info, 4);
        if (count > (uint)capacity) count = (uint)capacity;
        List<string> found = new List<string>();
        for (int i = 0; i < count; i++) {
          IntPtr slot = new IntPtr(info.ToInt64() + header + i * IntPtr.Size);
          long pid = Marshal.ReadIntPtr(slot).ToInt64();
          if (pid <= 0) continue;
          long created = 0;
          try { created = Process.GetProcessById((int)pid).StartTime.ToFileTimeUtc(); } catch (Exception) { }
          found.Add(pid.ToString() + ":" + created.ToString());
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
        CloseHandle(created.hThread);
        process = created.hProcess;
        processId = created.dwProcessId;
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
  $entries = @()
  if ($active -ne 0) {
    foreach ($pair in [AiWorkflows.Native]::Survivors($job)) {
      $split = $pair.IndexOf(':')
      $pidText = $pair.Substring(0, $split)
      $createdText = $pair.Substring($split + 1)
      $entries += ('{"pid":' + $pidText + ',"created":"' + $createdText + '"}')
    }
  }
  $survivors = '[' + ($entries -join ',') + ']'
  [System.IO.File]::WriteAllText($result, ('{"childExit":' + $code + ',"treeEmpty":' + $empty + ',"survivors":' + $survivors + '}'))
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
  readonly survivors: readonly QuarantineSurvivor[];
}

function readReport(file: string): Report | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record['childExit'] === 'number' ? { childExit: record['childExit'] } : {}),
    ...(typeof record['treeEmpty'] === 'boolean' ? { treeEmpty: record['treeEmpty'] } : {}),
    ...(typeof record['empty'] === 'boolean' ? { empty: record['empty'] } : {}),
    ...(typeof record['error'] === 'string' ? { error: record['error'] } : {}),
    survivors: readReportSurvivors(record['survivors']),
  };
}

function readReportSurvivors(value: unknown): readonly QuarantineSurvivor[] {
  if (!Array.isArray(value)) return [];
  const survivors: QuarantineSurvivor[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const pid = record['pid'];
    const created = record['created'];
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && typeof created === 'string') {
      survivors.push({ pid, created });
    }
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

export function launchWindowsGroup(options: LaunchInGroupOptions): ProcessGroup {
  const job = `Local\\ai-workflows-${randomUUID()}`;
  const baseQuarantine: Quarantine = { host: hostname(), platform: 'win32', job, confirmed: false };
  let survivors: readonly QuarantineSurvivor[] = [];
  const stdoutBytes = options.stdoutBytes ?? DEFAULT_STDOUT_BYTES;
  const directory = mkdtempSync(join(tmpdir(), 'aiw-group-'));
  const stdinFile = join(directory, 'stdin.txt');
  const resultFile = join(directory, 'result.json');
  writeFileSync(stdinFile, options.stdin, 'utf8');
  ensureSource();

  const application = options.command;
  const commandLine = [application, ...options.args].map(quoteWindowsArgument).join(' ');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
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

  const exited = new Promise<void>((resolve) => {
    child.on('close', () => resolve());
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
      const timer = setTimeout(() => resolve(true), TERMINATE_TIMEOUT_MS);
      timer.unref?.();
      void exited.then(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (timedOut) {
      // The launcher did not answer: its own answer is lost, so the system may be asked again.
      removeQuietly(directory);
      return { empty: false, lost: true };
    }
    const report = readReport(resultFile);
    removeQuietly(directory);
    if (report === undefined) return { empty: false, lost: true };
    survivors = report.survivors;
    if (report.treeEmpty === true) return { empty: true };
    if (report.treeEmpty === false) return { empty: false };
    // A launcher error (the job could not be created or the child could not start) leaves no
    // emptiness claim to trust: the system is asked again instead.
    return { empty: false, lost: true };
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
      const report = readReport(resultFile);
      if (report === undefined) {
        return { kind: 'technical', reason: `could not start ${application}: the launcher did not report a result` };
      }
      if (typeof report.error === 'string') {
        return { kind: 'technical', reason: `could not start ${application}: ${report.error}` };
      }
      // A launcher result without an exit code is never a clean exit: reading it as 0 would
      // approve whatever the child printed before dying.
      if (typeof report.childExit !== 'number') {
        return { kind: 'technical', reason: `could not start ${application}: the launcher did not report an exit code` };
      }
      return {
        kind: 'exited',
        code: report.childExit,
        stdout: value.stdout,
        stderr: value.stderr,
        truncated: false,
      };
    })();
    return waitPromise;
  };

  return {
    get quarantine(): Quarantine {
      return survivors.length === 0 ? baseQuarantine : { ...baseQuarantine, survivors };
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
  return { empty: false, reason: `the job object "${job}" still has processes` };
}

/**
 * Whether any of the survivors the launcher named is still the same process: alive, with the
 * very creation time recorded. A pid reused by another process counts as gone — and then only
 * the job name answers, which is the rule for a quarantine without live survivors.
 */
export async function windowsSurvivorAlive(
  survivors: readonly QuarantineSurvivor[],
): Promise<boolean> {
  for (const survivor of survivors) {
    if (await survivorAlive(survivor.pid, survivor.created)) return true;
  }
  return false;
}

async function survivorAlive(pid: number, created: string): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Both values come from the launcher itself; the guard keeps a repaired quarantine from
  // turning into a PowerShell injection anyway.
  if (!/^\d+$/.test(created)) return false;
  const script =
    `try { $p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
    `if ($p.StartTime.ToFileTimeUtc().ToString() -eq "${created}") { "alive" } else { "other" } } ` +
    `catch { "dead" }`;
  const output = await runPowershell(script);
  return output.trim() === 'alive';
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
