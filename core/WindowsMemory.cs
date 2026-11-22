using System.Diagnostics;
using System.Runtime.InteropServices;

namespace TrueDoF;

/// <summary>
/// Reads FM's memory through Windows' ReadProcessMemory. This is a READ-ONLY handle: we never
/// ask Windows for write access, so writing to the game is impossible by construction.
/// ReadProcessMemory copies bytes inside the kernel and simply returns "failed" on a bad
/// address, so a wrong pointer can never crash FM.
/// </summary>
public sealed class WindowsMemory : IMemory, IDisposable
{
    private readonly nint _handle;
    private readonly bool _ownsHandle;
    private readonly Process _process;

    public bool IsOwnProcess { get; }

    private WindowsMemory(nint handle, Process process, bool ownsHandle, bool isOwnProcess)
    {
        _handle = handle; _process = process; _ownsHandle = ownsHandle; IsOwnProcess = isOwnProcess;
    }

    /// <summary>Used by the BepInEx plugin: we are running inside fm.exe.</summary>
    public static WindowsMemory ForCurrentProcess() =>
        new(Native.GetCurrentProcess(), Process.GetCurrentProcess(), false, true);

    /// <summary>Used by the command-line tool: open a running fm.exe with read-only rights.</summary>
    public static WindowsMemory OpenExternal(Process p)
    {
        nint h = Native.OpenProcess(Native.PROCESS_VM_READ | Native.PROCESS_QUERY_INFORMATION, false, p.Id);
        if (h == 0)
            throw new InvalidOperationException(
                $"Could not open fm.exe (Windows error {Marshal.GetLastWin32Error()}). " +
                "If FM runs as administrator, run TrueDoF.Cli as administrator too.");
        return new WindowsMemory(h, p, true, false);
    }

    public unsafe bool Read(ulong address, Span<byte> dest)
    {
        if (address == 0 || dest.Length == 0) return false;
        fixed (byte* p = dest)
            return Native.ReadProcessMemory(_handle, address, p, (nuint)dest.Length, out nuint read)
                   && (int)read == dest.Length;
    }

    public List<MemRegion> HeapRegions()
    {
        var list = new List<MemRegion>();
        ulong addr = 0x10000;
        int size = Marshal.SizeOf<Native.MEMORY_BASIC_INFORMATION>();
        for (int guard = 0; guard < 2_000_000 && addr < 0x7FFF_FFFF_FFFFUL; guard++)
        {
            if (Native.VirtualQueryEx(_handle, addr, out var m, (ulong)size) == 0 || m.RegionSize == 0) break;
            bool heapLike =
                m.State == Native.MEM_COMMIT &&
                m.Type == Native.MEM_PRIVATE &&                       // heap, not DLL images or mapped files
                (m.Protect & (Native.PAGE_GUARD | Native.PAGE_NOACCESS)) == 0 &&
                (m.Protect & (Native.PAGE_READWRITE | Native.PAGE_WRITECOPY)) != 0 &&
                m.RegionSize <= 512UL * 1024 * 1024;
            if (heapLike) list.Add(new MemRegion(m.BaseAddress, m.RegionSize));
            addr = m.BaseAddress + m.RegionSize;
        }
        return list;
    }

    public ModuleInfo FindModule(string name)
    {
        try
        {
            _process.Refresh();   // game_plugin.dll loads late; refresh the module list
            foreach (ProcessModule m in _process.Modules)
            {
                if (!string.Equals(m.ModuleName, name, StringComparison.OrdinalIgnoreCase)) continue;
                var info = new ModuleInfo
                {
                    Name = m.ModuleName,
                    Base = (ulong)m.BaseAddress.ToInt64(),
                    Size = (ulong)m.ModuleMemorySize,
                    Path = m.FileName,
                };
                try
                {
                    var v = FileVersionInfo.GetVersionInfo(m.FileName);
                    info.FileVersion = v.FileVersion;
                    info.Major = v.FileMajorPart;
                    info.Minor = v.FileMinorPart;
                }
                catch { /* version is nice-to-have */ }
                return info;
            }
        }
        catch (Exception e) { Log.Warn($"Module list unavailable: {e.Message}"); }
        return null;
    }

    public void Dispose()
    {
        if (_ownsHandle) Native.CloseHandle(_handle);
    }
}

/// <summary>Windows API declarations. Nothing in here can write to another process.</summary>
internal static class Native
{
    public const uint PROCESS_VM_READ = 0x0010;
    public const uint PROCESS_QUERY_INFORMATION = 0x0400;
    public const uint MEM_COMMIT = 0x1000;
    public const uint MEM_PRIVATE = 0x20000;
    public const uint PAGE_NOACCESS = 0x01;
    public const uint PAGE_READWRITE = 0x04;
    public const uint PAGE_WRITECOPY = 0x08;
    public const uint PAGE_GUARD = 0x100;

    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION
    {
        public ulong BaseAddress;
        public ulong AllocationBase;
        public uint AllocationProtect;
        public uint Alignment1;
        public ulong RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
        public uint Alignment2;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern nint OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    public static extern nint GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(nint h);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern unsafe bool ReadProcessMemory(nint process, ulong address, void* buffer, nuint size, out nuint read);

    [DllImport("kernel32.dll")]
    public static extern ulong VirtualQueryEx(nint process, ulong address, out MEMORY_BASIC_INFORMATION info, ulong length);

    // --- keyboard (hotkey) ---
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    public static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(nint hWnd, out uint processId);
}
