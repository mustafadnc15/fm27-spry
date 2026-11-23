using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace TrueDoF;

/// <summary>A player found in memory: just enough to read details later.</summary>
public sealed class PlayerRef
{
    public uint Uid;
    public ulong Person;   // person block (where the vtable sits)
    public ulong Block;    // player block = Person - class offset
}

/// <summary>A raw transfer-deal record found in memory.</summary>
public struct DealRaw
{
    public ulong Person, ToTeam, FromTeam;
    public uint Date;
    public byte Status;
}

public sealed class ScanResult
{
    public readonly Dictionary<uint, PlayerRef> Players = new();
    public readonly Dictionary<ulong, uint> AddrToUid = new();     // person AND block address → uid
    public readonly List<ulong> ManagerPersons = new();
    public readonly List<DealRaw> Deals = new();
    public readonly Dictionary<int, long> ClassHistogram = new();  // class offset → count (diagnostics)
    public readonly List<ulong> Selections = new();                 // match-engine team selections (your tactic lives there)
    public readonly Dictionary<ulong, long> VtableCounts = new();   // vtable → objects seen (diagnostics)
    public readonly Dictionary<ulong, string> VtableNames = new();  // vtable → C++ class name, where readable
    public long BytesTotal, BytesUnreadable, Candidates;
    public int RegionErrors;
    public string FirstRegionError;
    public double UnreadableFraction => BytesTotal == 0 ? 0 : (double)BytesUnreadable / BytesTotal;
}

/// <summary>
/// The one big pass over FM's heap. How it recognises things:
///
///  * Every C++ object starts with a "vtable" pointer that points into the game's code
///    (game_plugin.dll or GameAssembly.dll). So any 8-byte value pointing there is a candidate.
///  * Microsoft's C++ compiler stores, just before each vtable, a pointer to a little info
///    record; the number at +4 in that record is fixed per class. That number tells us
///    "this is a player" / "this is the human manager" (see Layout.*Class).
///  * Transfer deals have no vtable but always carry two fixed marker values, so we spot them
///    by those markers in the same pass.
///
/// We only copy bytes out (never call game code), so this is safe on a background thread.
/// </summary>
public static class HeapScanner
{
    private const int ChunkBytes = 16 * 1024 * 1024;
    private const int Overlap = 0x80;   // re-read a little at chunk edges so nothing on a border is missed
    private const int MaxWorkers = 6;

    // Read buffers are reused between dumps and pinned (they never move), so we can tell
    // the scanner to skip them: inside fm.exe they would otherwise contain copies of FM objects.
    private static byte[][] _buffers = Array.Empty<byte[]>();

    public static int WorkerCount() => Math.Clamp(Environment.ProcessorCount - 1, 1, MaxWorkers);

    public static ScanResult Scan(Mem mem, Layout L, ModuleInfo gp, ModuleInfo ga, List<MemRegion> regions, Action<double> progress)
    {
        int workers = WorkerCount();
        EnsureBuffers(workers);

        // Our own buffers must not be scanned when we live inside fm.exe.
        var skip = new List<(ulong lo, ulong hi)>();
        if (mem.Source.IsOwnProcess)
            foreach (var b in _buffers) skip.Add(AddressRange(b));

        ulong modLo = Math.Min(gp.Base, ga?.Base ?? gp.Base);
        ulong modHi = Math.Max(gp.End, ga?.End ?? gp.End);
        var classCache = new ConcurrentDictionary<ulong, VtInfo>();
        var result = new ScanResult();
        foreach (var r in regions) result.BytesTotal += (long)r.Size;
        long done = 0;
        var locals = new ScanResult[workers];
        var threads = new Thread[workers];

        for (int w = 0; w < workers; w++)
        {
            int worker = w;
            var local = locals[w] = new ScanResult();
            threads[w] = new Thread(() =>
            {
                byte[] buf = _buffers[worker];
                for (int ri = worker; ri < regions.Count; ri += workers)
                {
                    var region = regions[ri];
                    ulong pos = 0;
                    try
                    {
                        while (pos < region.Size)
                        {
                            int want = (int)Math.Min((ulong)ChunkBytes, region.Size - pos);
                            ulong chunk = region.Start + pos;
                            bool last = pos + (ulong)want >= region.Size;
                            if (Overlaps(skip, chunk, (ulong)want) || !mem.Read(chunk, buf.AsSpan(0, want)))
                            {
                                if (!Overlaps(skip, chunk, (ulong)want)) local.BytesUnreadable += want;
                                pos += (ulong)want;
                                Interlocked.Add(ref done, want);
                                continue;
                            }
                            ScanChunk(mem, L, gp, ga, modLo, modHi, classCache, buf, want, chunk, local);
                            int step = last ? want : want - Overlap;
                            pos += (ulong)step;
                            long d = Interlocked.Add(ref done, step);
                            if (worker == 0 && result.BytesTotal > 0) progress?.Invoke((double)d / result.BytesTotal);
                        }
                    }
                    catch (Exception e)
                    {
                        // One weird region must never kill the whole dump: count it and move on.
                        local.RegionErrors++;
                        local.FirstRegionError ??= e.Message;
                        local.BytesUnreadable += (long)(region.Size - pos);
                    }
                }
            }) { IsBackground = true, Name = $"TrueDoF-scan-{w}" };
            threads[w].Start();
        }
        foreach (var t in threads) t.Join();

        // Merge per-thread results (no locks needed during the scan).
        var dealSeen = new HashSet<(ulong, ulong, ulong, uint, byte)>();
        foreach (var l in locals)
        {
            foreach (var kv in l.Players) result.Players.TryAdd(kv.Key, kv.Value);
            foreach (var kv in l.AddrToUid) result.AddrToUid[kv.Key] = kv.Value;
            foreach (var kv in l.ClassHistogram) result.ClassHistogram[kv.Key] = result.ClassHistogram.GetValueOrDefault(kv.Key) + kv.Value;
            foreach (var m in l.ManagerPersons) if (!result.ManagerPersons.Contains(m)) result.ManagerPersons.Add(m);
            foreach (var sel in l.Selections) if (!result.Selections.Contains(sel)) result.Selections.Add(sel);
            foreach (var kv in l.VtableCounts) result.VtableCounts[kv.Key] = result.VtableCounts.GetValueOrDefault(kv.Key) + kv.Value;
            foreach (var d in l.Deals)
                if (dealSeen.Add((d.Person, d.ToTeam, d.FromTeam, d.Date, d.Status))) result.Deals.Add(d);
            result.BytesUnreadable += l.BytesUnreadable;
            result.Candidates += l.Candidates;
            result.RegionErrors += l.RegionErrors;
            result.FirstRegionError ??= l.FirstRegionError;
        }
        foreach (var kv in classCache) if (kv.Value.Name != null) result.VtableNames[kv.Key] = kv.Value.Name;
        return result;
    }

    /// <summary>What we know about one vtable (looked up once, then cached).</summary>
    private readonly struct VtInfo
    {
        public readonly int Cls;          // class offset fingerprint ([vtable-8]+4)
        public readonly string Name;      // C++ class name from RTTI, or null
        public readonly bool Selection;   // simatch::PREPARED_TACTICS_CREATOR_ARRAY
        public VtInfo(int cls, string name, bool selection) { Cls = cls; Name = name; Selection = selection; }
    }

    private static VtInfo Describe(Mem mem, Layout L, ModuleInfo gp, ModuleInfo ga, ulong vt)
    {
        ulong col = mem.Ptr(vt - 8);
        if (col == 0) return new VtInfo(0, null, false);
        int cls = mem.I32(col + 4);
        var module = gp.Contains(vt) ? gp : ga;
        string name = RttiName(mem, L, col, module);
        return new VtInfo(cls, name, name == L.SelectionClass);
    }

    /// <summary>
    /// The C++ class name of a vtable, from Microsoft's run-time type information: the "complete object
    /// locator" (at [vtable-8]) stores, at +0x0C, where the type descriptor is relative to the module's start;
    /// the descriptor holds the name at +0x10, e.g. ".?AVPREPARED_TACTICS_CREATOR_ARRAY@simatch@@".
    /// Every step is checked; anything odd returns null.
    /// </summary>
    public static string RttiName(Mem mem, Layout L, ulong col, ModuleInfo module)
    {
        if (col == 0 || module == null) return null;
        if (mem.I32(col + (ulong)L.ColSignature) != 1) return null;   // x64 locators carry signature 1
        int rva = mem.I32(col + (ulong)L.ColTypeDescriptor);
        if (rva <= 0 || (ulong)rva >= module.Size) return null;
        string name = mem.CString(module.Base + (ulong)rva + (ulong)L.TypeDescriptorName, 200);
        return name != null && name.StartsWith(".?A", StringComparison.Ordinal) ? name : null;
    }

    private static void ScanChunk(Mem mem, Layout L, ModuleInfo gp, ModuleInfo ga, ulong modLo, ulong modHi,
                                  ConcurrentDictionary<ulong, VtInfo> classCache, byte[] buf, int len, ulong chunkBase, ScanResult local)
    {
        var span = buf.AsSpan(0, len);
        for (int i = 0; i + 0x10 <= len; i += 8)
        {
            // --- transfer deal? (cheap marker check first) ---
            if (i + L.DealRecordBytes <= len
                && BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(i + L.DealMarker2)) == L.DealMarker2Value
                && BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(i + L.DealMarker1)) == L.DealMarker1Value)
            {
                local.Deals.Add(new DealRaw
                {
                    Person = BinaryPrimitives.ReadUInt64LittleEndian(span.Slice(i + L.DealPerson)),
                    ToTeam = BinaryPrimitives.ReadUInt64LittleEndian(span.Slice(i + L.DealToTeam)),
                    FromTeam = BinaryPrimitives.ReadUInt64LittleEndian(span.Slice(i + L.DealFromTeam)),
                    Date = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(i + L.DealDate)),
                    Status = span[i + L.DealStatus],
                });
            }

            // --- object with a vtable into the game's code? ---
            ulong vt = BinaryPrimitives.ReadUInt64LittleEndian(span.Slice(i));
            if (vt < modLo || vt >= modHi || (vt & 7) != 0) continue;
            if (!gp.Contains(vt) && (ga == null || !ga.Contains(vt))) continue;
            local.Candidates++;

            var info = classCache.GetOrAdd(vt, v => Describe(mem, L, gp, ga, v));
            if (info.Name != null) local.VtableCounts[vt] = local.VtableCounts.GetValueOrDefault(vt) + 1;   // real classes only
            ulong p = chunkBase + (ulong)i;
            if (info.Selection) { local.Selections.Add(p); continue; }   // checked later by TacticReader

            int cls = info.Cls;
            if (cls <= 0 || cls >= 0x2000) continue;

            uint uid = i + L.Uid + 4 <= len
                ? BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(i + L.Uid))
                : mem.U32(p + (ulong)L.Uid);
            if (uid == 0 || uid == 0xFFFFFFFF) continue;
            local.ClassHistogram[cls] = local.ClassHistogram.GetValueOrDefault(cls) + 1;

            if (cls == L.PlayerClass || cls == L.PlayerStaffClass)
            {
                ulong block = p - (ulong)cls;
                ushort ca = mem.U16(block + (ulong)L.Ca), pa = mem.U16(block + (ulong)L.Pa);
                if (ca < 1 || ca > 200 || pa < 1 || pa > 200) continue;
                if (!local.Players.ContainsKey(uid))
                    local.Players[uid] = new PlayerRef { Uid = uid, Person = p, Block = block };
                local.AddrToUid[p] = uid;
                local.AddrToUid[block] = uid;
            }
            else if (cls == L.HumanManagerClass)
            {
                local.ManagerPersons.Add(p);
            }
        }
    }

    private static void EnsureBuffers(int count)
    {
        if (_buffers.Length >= count) return;
        var list = new List<byte[]>(_buffers);
        while (list.Count < count) list.Add(GC.AllocateUninitializedArray<byte>(ChunkBytes, pinned: true));
        _buffers = list.ToArray();
    }

    private static unsafe (ulong lo, ulong hi) AddressRange(byte[] b)
    {
        // Pinned arrays never move, so taking the address once is safe.
        fixed (byte* p = b) return ((ulong)p, (ulong)p + (ulong)b.Length);
    }

    private static bool Overlaps(List<(ulong lo, ulong hi)> skip, ulong start, ulong len)
    {
        foreach (var (lo, hi) in skip) if (start < hi && start + len > lo) return true;
        return false;
    }
}
