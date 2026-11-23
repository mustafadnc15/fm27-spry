using System.Buffers.Binary;
using System.Text;

namespace TrueDoF;

/// <summary>
/// Reads the tactic you play from FM's memory (read-only), so the Director knows it without tactic.txt.
///
/// How: the match engine keeps the team you picked as "selection" objects (class
/// simatch::PREPARED_TACTICS_CREATOR_ARRAY, found by the heap scan). Each one lists 26 person ids (your eleven in
/// the formation's order, then the substitutes) and points at a tactic block that holds the style and, for each
/// of the eleven slots, a role code with the ball and one without. FM also keeps copies for other clubs and old
/// copies, so we keep only selections whose eleven are mostly YOUR players.
///
/// FM writes the block when you leave the tactics screen, so changes show up after that (and the next F8).
/// Positions (DL, AM(R)...) are not in the block; the briefing works them out from each role and player.
/// Every read can fail harmlessly; problems go to diagnostics.txt and the dump simply has no tactic.
/// </summary>
public static class TacticReader
{
    private const uint Empty = 0xFFFFFFFF;

    public static TacticInfo Read(Mem m, Layout L, ScanResult scan, Dump dump, List<string> diag)
    {
        diag.Add($"Tactic: {scan.Selections.Count} selection object(s) of {L.SelectionClass} found.");
        if (scan.Selections.Count == 0) return null;

        // Person id → our squad player.
        var ours = new Dictionary<uint, PlayerInfo>();
        foreach (var p in dump.Squad)
            if (scan.Players.TryGetValue(p.Uid, out var pr))
            {
                uint id = m.U32(pr.Person + (ulong)L.PersonId);
                if (id != 0 && id != Empty) ours[id] = p;
            }

        var found = new List<(ulong sel, uint[] ids, int mine, ulong block, TacticInfo tactic)>();
        foreach (ulong sel in scan.Selections)
        {
            try
            {
                var ids = ReadIds(m, L, sel);
                if (ids == null) continue;
                int mine = ids.Take(11).Count(ours.ContainsKey);
                ulong block = BlockOf(m, L, sel);
                diag.Add($"  selection @0x{sel:X}: {mine}/11 of our players in the eleven, tactic block {(block == 0 ? "none" : $"@0x{block:X}")}");
                if (mine < Math.Min(6, ours.Count) || mine == 0 || block == 0) continue;   // another club's team, or a freed copy
                var t = ReadBlock(m, L, block, diag);
                if (t == null) continue;
                found.Add((sel, ids, mine, block, t));
            }
            catch (Exception e) { diag.Add($"  selection @0x{sel:X}: skipped ({e.Message})"); }
        }
        if (found.Count == 0)
        {
            diag.Add("Tactic: no selection holds our players with a readable tactic (open the tactics screen once, leave it, and press F8 again).");
            return null;
        }

        // Several copies can exist (and one per saved tactic). Take the one with most of our players; among equals,
        // the tactic most copies agree on.
        string Key(TacticInfo t) => t.StyleTag + "|" + string.Join(",", t.Slots.Select(s => s.InPossessionMask + "/" + s.OutOfPossessionMask));
        var byKey = found.GroupBy(f => Key(f.tactic)).ToList();
        var best = found.OrderByDescending(f => f.mine).ThenByDescending(f => byKey.First(g => g.Key == Key(f.tactic)).Count()).First();
        var tactic = best.tactic;
        tactic.Copies = byKey.First(g => g.Key == Key(tactic)).Count();
        tactic.OtherTactics = byKey.Count - 1;
        if (tactic.OtherTactics > 0)
            tactic.Note = $"FM holds {byKey.Count} different tactics for your team (e.g. your other tactic slots); this is the one with most of your current players.";

        for (int i = 0; i < tactic.Slots.Count && i < 11; i++)
            if (ours.TryGetValue(best.ids[i], out var p)) { tactic.Slots[i].PlayerUid = p.Uid; tactic.Slots[i].Player = p.Name; }
        foreach (uint id in best.ids.Skip(11))
            if (ours.TryGetValue(id, out var p)) tactic.Substitutes.Add(p.Name);

        diag.Add($"Tactic: using selection @0x{best.sel:X} (block @0x{best.block:X}), style {tactic.StyleTag ?? "?"}, {tactic.Copies} copies, {tactic.OtherTactics} other tactic(s).");
        foreach (var s in tactic.Slots)
            diag.Add($"  slot {s.Slot,2}: {s.InPossessionRole ?? "?"} (bit {s.InPossessionBit}, mask {s.InPossessionMask}) / " +
                     $"{s.OutOfPossessionRole ?? "?"} (bit {s.OutOfPossessionBit}, mask {s.OutOfPossessionMask})  {s.Player ?? "-"}");
        return tactic;
    }

    private static uint[] ReadIds(Mem m, Layout L, ulong sel)
    {
        var buf = new byte[4 * L.SelSlotCount];
        if (!m.Read(sel + (ulong)L.SelSlots, buf)) return null;
        var ids = new uint[L.SelSlotCount];
        for (int i = 0; i < ids.Length; i++) ids[i] = BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan(4 * i));
        return ids;
    }

    /// <summary>The tactic block: first entry of the selection's list, if the list looks sound.</summary>
    private static ulong BlockOf(Mem m, Layout L, ulong sel)
    {
        ulong begin = m.Ptr(sel + (ulong)L.SelList), end = m.Ptr(sel + (ulong)L.SelList + 8);
        if (begin == 0 || end <= begin || end - begin > 8 * 64 || (end - begin) % 8 != 0) return 0;
        return m.Ptr(begin);
    }

    private static TacticInfo ReadBlock(Mem m, Layout L, ulong block, List<string> diag)
    {
        var t = new TacticInfo();
        uint tag = m.U32(block + (ulong)L.TacStyle);
        // The tag is text stored backwards: bytes "LLUN" in memory read as "NULL".
        var chars = new[] { (char)(tag >> 24), (char)((tag >> 16) & 0xFF), (char)((tag >> 8) & 0xFF), (char)(tag & 0xFF) };
        if (chars.All(c => c >= 'A' && c <= 'Z')) t.StyleTag = new string(chars);
        t.Style = t.StyleTag != null && Layout.TacticStyles.TryGetValue(t.StyleTag, out var name) ? name : null;
        if (t.StyleTag == null) diag.Add($"  block @0x{block:X}: style tag at +0x{L.TacStyle:X} is not text (raw 0x{tag:X8}); custom tactics may have none");

        int good = 0;
        for (int i = 0; i < 11; i++)
        {
            ulong ip = m.Ptr(block + (ulong)(L.TacInPossession + i * L.TacSlotSize + L.TacRoleMask));
            ulong oop = m.Ptr(block + (ulong)(L.TacOutOfPossession + i * L.TacSlotSize + L.TacRoleMask));
            var (ipBit, ipOk) = RoleBit(ip);
            var (oopBit, oopOk) = RoleBit(oop);
            if (ipOk && oopOk) good++;
            t.Slots.Add(new TacticSlotInfo
            {
                Slot = i + 1,
                InPossessionMask = $"0x{ip:X}", OutOfPossessionMask = $"0x{oop:X}",
                InPossessionBit = ipBit, OutOfPossessionBit = oopBit,
                InPossessionRole = ipOk ? Layout.InPossessionRoles.GetValueOrDefault(ipBit) : null,
                OutOfPossessionRole = oopOk ? Layout.OutOfPossessionRoles.GetValueOrDefault(oopBit) : null,
            });
        }
        // A real block has a role mask of the documented shape in (nearly) every slot.
        if (good < 10) { diag.Add($"  block @0x{block:X}: only {good}/11 slots look like role masks; ignored"); return null; }
        return t;
    }

    /// <summary>A role mask holds one of bits 21-23 plus one bit naming the role. Returns that bit.</summary>
    public static (int bit, bool ok) RoleBit(ulong mask)
    {
        int group = -1, role = -1, count = 0;
        for (int b = 0; b < 64; b++)
        {
            if ((mask & (1UL << b)) == 0) continue;
            count++;
            if (b >= 21 && b <= 23 && group < 0) group = b; else role = b;
        }
        return count == 2 && group >= 0 && role >= 0 ? (role, true) : (-1, false);
    }
}
