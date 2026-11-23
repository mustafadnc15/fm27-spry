namespace TrueDoF;

/// <summary>
/// WHERE things live in FM's memory, per FM version ("offsets"). If an FM patch breaks
/// TrueDoF, this is almost always the only file that needs new numbers.
/// See TROUBLESHOOTING.md (Phase 4) and diagnostics.txt for how to re-find them.
///
/// Values are facts about FM's memory layout, documented in docs/how-fmsuperscout-reads-data.md.
/// "block" = the player block, "person" = the person block (block + class offset).
/// </summary>
public sealed class Layout
{
    public string Name = "FM27";
    public int Major = 27;
    public int[] VerifiedMinors = { 0, 1 };

    // ---- Class fingerprints: the int at [vtable-8]+4 (distance person → object start) ----
    public int PlayerClass = 0x288;
    public int PlayerStaffClass = 0x380;   // a player who also has a staff job
    public int StaffClass = 0x100;
    public int HumanManagerClass = 0x440;  // you

    public int Uid = 0x0C;                 // u32 unique ID, on the person block

    // ---- Player block ----
    public int Ca = 0x264, Pa = 0x266;                       // u16, true 1..200
    public int HomeRep = 0x25E, CurRep = 0x260, WorldRep = 0x262;
    public int Condition = 0x258;                            // u16, UNVERIFIED
    public int Morale = 0x26C;                               // byte 1..20 (10 Okay, 13 Good, 20 Perfect)
    public int Height = 0x22E;                               // u16 cm
    public int Positions = 0x150;                            // 15 bytes, 1..20 (20 = natural)
    public int Attrs = 0x15F;                                // bytes stored x5
    public int Value = 0x234, AskingPrice = 0x238;           // u32 GBP

    // ---- Person block ----
    public int Gender = 0x19; public byte FemaleBit = 0x10;
    public int FirstName = 0x50, SecondName = 0x58, CommonName = 0x60;   // nested strings
    public int Nation = 0x68;                                // ptr → nation
    public int DateOfBirth = 0x88;                           // FM date
    public int Contract = 0xA8;                              // ptr → contract
    // Loans (FMLibreEditor + FM OpenEditor): [person+LoanRecord] → record; [record+0] → loan contract,
    // laid out like a contract (+0x10 team he is on loan to, +0x48 loan end date).
    public int LoanRecord = 0xB0;
    public int Personality = 0x70;                           // 8 raw bytes 1..20

    // ---- Contract ----
    public int ConWage = 0x20, ConExpiry = 0x48, ConSquadNumber = 0x5D, ConFlags = 0x57, ConTeam = 0x10, ConJob = 0x26;
    // ConFlags bits: 0 = transfer listed, 1 = loan listed (confirmed by FMLibreEditor and FM OpenEditor).
    public int ConSquadStatus = 0x54;   // byte code, grouped as in SquadStatusGroups below (FMLibreEditor census)

    /// <summary>FM's exact squad-status names, confirmed in the user's save.</summary>
    public static readonly Dictionary<int, string> SquadStatusNames = new()
    {
        [1] = "Star Player", [2] = "Important Player",
    };

    /// <summary>FM squad-status codes → group (FMLibreEditor census). Codes not listed are "unknown".</summary>
    public static readonly Dictionary<int, string> SquadStatusGroups = new()
    {
        [1] = "key player", [2] = "key player", [15] = "key player",
        [3] = "regular starter",
        [4] = "fringe", [5] = "fringe", [7] = "fringe", [9] = "fringe", [14] = "fringe", [16] = "fringe", [17] = "fringe", [20] = "fringe", [21] = "fringe",
        [10] = "prospect", [11] = "prospect", [13] = "prospect",
        [22] = "surplus / not needed",
    };

    // ---- Nation ----
    public int NationShortName = 0x20, NationName = 0x30;

    // ---- Club / team / competition ----
    public int ClubTeamsBegin = 0x18, ClubTeamsEnd = 0x20, ClubName = 0xC0, ClubShortName = 0xC8;
    public int TeamType = 0x28, TeamClub = 0x30, TeamPlayersBegin = 0x38, TeamPlayersEnd = 0x40;
    public int TeamManager = 0x80, TeamRep = 0xA8, TeamComp = 0x50, TeamCompAlt = 0x60;
    public int TeamSchedule = 0xA0, ScheduleNextMatch = 0x94, ScheduleNextMatchAlt = 0x18;
    public int CompName = 0x40, CompShortName = 0x48;

    // ---- Club finances: [club + ClubFinance] → finance record (i32 pounds) ----
    // Source: FMLibreEditor, FM OpenEditor and fm-editor (all GPL-3.0) document these FM27
    // offsets independently; only the numbers are used here, no code. Your own probe found
    // the balance at the same place. Small clubs in leagues you don't play have a smaller
    // finance record, so values are sanity-checked before use.
    public int ClubFinance = 0x150;
    public int FinBalance = 0x0C;           // i32 £
    public int FinTransferBudget = 0x7C4;   // i32 £
    public int FinWageBudget = 0x808;       // i32 £ per week
    public int FinWageSpend = 0x814;        // i32 £ per week: FM's own current wage total incl. bonuses

    // ---- Transfer deal records (no vtable; recognised by two marker values) ----
    public int DealPerson = 0x00, DealToTeam = 0x08, DealFromTeam = 0x18;
    public int DealMarker1 = 0x2C; public uint DealMarker1Value = 0xFFFFFFFF;
    public int DealMarker2 = 0x34; public uint DealMarker2Value = 0x076C0001;
    public int DealDate = 0x44, DealStatus = 0x55;
    public int DealRecordBytes => DealStatus + 1;

    // ---- MSVC run-time type information (x64): [vtable-8] → "complete object locator" ----
    public int ColSignature = 0x00;        // i32, 1 on x64
    public int ColTypeDescriptor = 0x0C;   // i32 offset of the type descriptor from the module's start
    public int TypeDescriptorName = 0x10;  // in the type descriptor: the class name, e.g. ".?AVTEAM@db@@"

    // ---- Your tactic (FMLibreEditor docs/recon/fm27-tactics-and-value.md and fm27-transfers.md; facts only) ----
    // The match engine keeps each picked team as an object of this class: 26 person ids (the eleven in the
    // formation's order, then the substitutes) and a list whose first entry points at the tactic block.
    public string SelectionClass = ".?AVPREPARED_TACTICS_CREATOR_ARRAY@simatch@@";
    public int PersonId = 0x08;            // u32 on the person block: the game's person id (= player block +0x290)
    public int SelList = 0x08;             // (begin, end, capacity) of pointers to tactic blocks
    public int SelSlots = 0x28;            // 26 x u32 person ids; 0xFFFFFFFF = empty
    public int SelSlotCount = 26;
    public int TacStyle = 0x100;           // u32 style tag, text backwards ("CONT", "GEGE", ...)
    public int TacInPossession = 0x148;    // 11 slot entries ...
    public int TacOutOfPossession = 0x468; // ... and 11 more
    public int TacSlotSize = 0x48;
    public int TacRoleMask = 0x10;         // in a slot entry: u64 role mask (one of bits 21-23 + one bit naming the role)

    /// <summary>Role bit → FM's abbreviation, with the ball (FMLibreEditor's reading on FM27 Steam + Game Pass).</summary>
    public static readonly Dictionary<int, string> InPossessionRoles = new()
    {
        [1] = "CB", [2] = "FB", [3] = "WB", [4] = "DM", [7] = "W", [9] = "AM", [10] = "DLF", [11] = "CFD", [12] = "BGK",
        [14] = "ACB", [16] = "BBM", [17] = "AP", [19] = "P", [24] = "BCB", [27] = "IF", [29] = "NCB", [35] = "HB",
        [38] = "AWB", [43] = "PW", [44] = "IWB", [45] = "WFD", [46] = "BBP", [48] = "WCM", [52] = "IFB", [53] = "NGK",
        [54] = "OCB", [55] = "PWB", [56] = "CHM",
    };

    /// <summary>Role bit → FM's abbreviation, without the ball.</summary>
    public static readonly Dictionary<int, string> OutOfPossessionRoles = new()
    {
        [1] = "SK", [2] = "LHK", [3] = "CB", [4] = "SCB", [5] = "CCB", [6] = "WCB", [9] = "FB", [10] = "PFB", [11] = "HFB",
        [12] = "WB", [14] = "HWB", [15] = "DM", [16] = "DDM", [17] = "PDM", [20] = "CM", [27] = "PCM", [28] = "SCM",
        [32] = "OAM", [38] = "W", [39] = "TW", [40] = "IOW", [42] = "CFD", [43] = "TCF", [44] = "OCF",
    };

    /// <summary>Style tags seen by FMLibreEditor, with the game's names.</summary>
    public static readonly Dictionary<string, string> TacticStyles = new()
    {
        ["CONT"] = "Control Possession", ["TIKI"] = "Tiki-Taka", ["DIRE"] = "Direct", ["GEGE"] = "Gegenpress",
        ["NULL"] = "custom (no style template)",   // seen on the user's own tactic (FM27 Game Pass 27.1)
    };

    public static readonly Layout FM27 = new();
    public static readonly Layout FM26 = new() { Name = "FM26", Major = 26, VerifiedMinors = new[] { 3 }, HumanManagerClass = 0x450 };

    /// <summary>Pick the layout for a game_plugin.dll version. Unknown versions get FM27 as best guess.</summary>
    public static (Layout layout, bool verified) For(int major, int minor)
    {
        var l = major == 26 ? FM26 : FM27;
        bool ok = major == l.Major && Array.IndexOf(l.VerifiedMinors, minor) >= 0;
        return (l, ok);
    }

    // ---- Attribute tables: (json key, group, offset from Attrs). All stored x5. ----
    public static readonly (string key, string group, int off)[] PlayerAttributes =
    {
        ("corners", "technical", 0x1B), ("crossing", "technical", 0x00), ("dribbling", "technical", 0x01),
        ("finishing", "technical", 0x02), ("firstTouch", "technical", 0x16), ("freeKicks", "technical", 0x23),
        ("heading", "technical", 0x03), ("longShots", "technical", 0x04), ("longThrows", "technical", 0x1E),
        ("marking", "technical", 0x05), ("passing", "technical", 0x07), ("penaltyTaking", "technical", 0x08),
        ("tackling", "technical", 0x09), ("technique", "technical", 0x17),

        ("aggression", "mental", 0x2D), ("anticipation", "mental", 0x11), ("bravery", "mental", 0x2B),
        ("composure", "mental", 0x34), ("concentration", "mental", 0x35), ("decisions", "mental", 0x12),
        ("determination", "mental", 0x33), ("flair", "mental", 0x1A), ("leadership", "mental", 0x28),
        ("offTheBall", "mental", 0x06), ("positioning", "mental", 0x14), ("teamwork", "mental", 0x1C),
        ("vision", "mental", 0x0A), ("workRate", "mental", 0x1D),

        ("acceleration", "physical", 0x22), ("agility", "physical", 0x2E), ("balance", "physical", 0x2A),
        ("jumpingReach", "physical", 0x27), ("naturalFitness", "physical", 0x32), ("pace", "physical", 0x26),
        ("stamina", "physical", 0x25), ("strength", "physical", 0x24),

        ("aerialReach", "goalkeeping", 0x0C), ("commandOfArea", "goalkeeping", 0x0D), ("communication", "goalkeeping", 0x0E),
        ("eccentricity", "goalkeeping", 0x1F), ("handling", "goalkeeping", 0x0B), ("kicking", "goalkeeping", 0x0F),
        ("oneOnOnes", "goalkeeping", 0x13), ("punching", "goalkeeping", 0x21), ("reflexes", "goalkeeping", 0x15),
        ("rushingOut", "goalkeeping", 0x20), ("throwing", "goalkeeping", 0x10),

        ("consistency", "hidden", 0x2C), ("dirtiness", "hidden", 0x29), ("importantMatches", "hidden", 0x2F),
        ("injuryProneness", "hidden", 0x30), ("versatility", "hidden", 0x31),
    };

    public const int LeftFoot = 0x18, RightFoot = 0x19;   // also x5, from Attrs

    /// <summary>Personality: raw 1..20 bytes from person+Personality, in this order.</summary>
    public static readonly string[] PersonalityKeys =
        { "adaptability", "ambition", "loyalty", "pressure", "professionalism", "sportsmanship", "temperament", "controversy" };

    /// <summary>15 position bytes from block+Positions, in this order.</summary>
    public static readonly string[] PositionKeys =
        { "GK", "SW", "DL", "DC", "DR", "DM", "ML", "MC", "MR", "AML", "AMC", "AMR", "ST", "WBL", "WBR" };
}
