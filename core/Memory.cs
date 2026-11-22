using System.Buffers.Binary;
using System.Text;

namespace TrueDoF;

/// <summary>A block of FM's memory we are allowed to scan (part of the heap).</summary>
public readonly struct MemRegion
{
    public readonly ulong Start;
    public readonly ulong Size;
    public MemRegion(ulong start, ulong size) { Start = start; Size = size; }
    public ulong End => Start + Size;
}

/// <summary>A loaded DLL inside FM (we care about game_plugin.dll and GameAssembly.dll).</summary>
public sealed class ModuleInfo
{
    public string Name;
    public ulong Base;
    public ulong Size;
    public string Path;
    public string FileVersion;   // e.g. "27.1.0.0"
    public int Major, Minor;
    public ulong End => Base + Size;
    public bool Contains(ulong addr) => addr >= Base && addr < End;
}

/// <summary>
/// Where bytes come from. On Windows: FM's process via ReadProcessMemory. In the self-test:
/// a fake, hand-built memory image. Everything else in TrueDoF only talks to this interface,
/// which is why the same logic can be tested on any machine.
///
/// Rule: implementations must NEVER crash on a bad address. They just return false.
/// </summary>
public interface IMemory
{
    /// <summary>Copy bytes at <paramref name="address"/> into <paramref name="dest"/>. False = not readable.</summary>
    bool Read(ulong address, Span<byte> dest);

    /// <summary>Heap regions worth scanning for FM's database objects.</summary>
    List<MemRegion> HeapRegions();

    /// <summary>Find a loaded module by file name, or null.</summary>
    ModuleInfo FindModule(string name);

    /// <summary>True when we run inside fm.exe itself (the BepInEx plugin).</summary>
    bool IsOwnProcess { get; }
}

/// <summary>
/// Typed, crash-proof reads on top of <see cref="IMemory"/>. Any failed read returns 0/null.
/// </summary>
public sealed class Mem
{
    private readonly IMemory _src;
    public Mem(IMemory src) { _src = src; }
    public IMemory Source => _src;

    public bool Read(ulong addr, Span<byte> dest) => addr != 0 && _src.Read(addr, dest);

    public ulong Ptr(ulong a) { Span<byte> b = stackalloc byte[8]; return Read(a, b) ? BinaryPrimitives.ReadUInt64LittleEndian(b) : 0; }
    public long I64(ulong a) { Span<byte> b = stackalloc byte[8]; return Read(a, b) ? BinaryPrimitives.ReadInt64LittleEndian(b) : 0; }
    public uint U32(ulong a) { Span<byte> b = stackalloc byte[4]; return Read(a, b) ? BinaryPrimitives.ReadUInt32LittleEndian(b) : 0; }
    public int I32(ulong a) { Span<byte> b = stackalloc byte[4]; return Read(a, b) ? BinaryPrimitives.ReadInt32LittleEndian(b) : 0; }
    public ushort U16(ulong a) { Span<byte> b = stackalloc byte[2]; return Read(a, b) ? BinaryPrimitives.ReadUInt16LittleEndian(b) : (ushort)0; }
    public byte U8(ulong a) { Span<byte> b = stackalloc byte[1]; return Read(a, b) ? b[0] : (byte)0; }

    /// <summary>FM "indirect" string: [addr] points to a block, UTF-8 text starts 4 bytes in.</summary>
    public string IndirectString(ulong addr)
    {
        ulong p = Ptr(addr);
        return p == 0 ? null : CString(p + 4);
    }

    /// <summary>FM "nested" string: [addr] → outer, [outer] → inner, text at inner+4. Used for person names.</summary>
    public string NestedString(ulong addr)
    {
        ulong outer = Ptr(addr);
        if (outer == 0) return null;
        ulong inner = Ptr(outer);
        return inner == 0 ? null : CString(inner + 4);
    }

    /// <summary>Zero-terminated UTF-8 text. Returns null for empty or obviously-garbage text.</summary>
    public string CString(ulong addr, int maxLen = 128)
    {
        Span<byte> buf = stackalloc byte[maxLen];
        if (!Read(addr, buf))
        {
            // The text might sit right at the end of a memory block: try a shorter read.
            buf = buf.Slice(0, 32);
            if (!Read(addr, buf)) return null;
        }
        int n = buf.IndexOf((byte)0);
        if (n < 0) n = buf.Length;
        if (n == 0) return null;
        string s;
        try { s = Encoding.UTF8.GetString(buf.Slice(0, n)).Trim(); }
        catch { return null; }
        if (s.Length == 0) return null;
        foreach (char c in s) if (char.IsControl(c) || c == '�') return null;
        return s;
    }
}
