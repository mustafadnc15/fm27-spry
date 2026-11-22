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
    public int Morale = 0x26C;                               // byte, UNVERIFIED
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
    public int Personality = 0x70;                           // 8 raw bytes 1..20

    // ---- Contract ----
    public int ConWage = 0x20, ConExpiry = 0x48, ConSquadNumber = 0x5D, ConFlags = 0x57, ConTeam = 0x10, ConJob = 0x26;

    // ---- Nation ----
    public int NationShortName = 0x20, NationName = 0x30;

    // ---- Club / team / competition ----
    public int ClubTeamsBegin = 0x18, ClubTeamsEnd = 0x20, ClubName = 0xC0, ClubShortName = 0xC8;
    public int TeamType = 0x28, TeamClub = 0x30, TeamPlayersBegin = 0x38, TeamPlayersEnd = 0x40;
    public int TeamManager = 0x80, TeamRep = 0xA8, TeamComp = 0x50, TeamCompAlt = 0x60;
    public int TeamSchedule = 0xA0, ScheduleNextMatch = 0x94, ScheduleNextMatchAlt = 0x18;
    public int CompName = 0x40, CompShortName = 0x48;

    // ---- Transfer deal records (no vtable; recognised by two marker values) ----
    public int DealPerson = 0x00, DealToTeam = 0x08, DealFromTeam = 0x18;
    public int DealMarker1 = 0x2C; public uint DealMarker1Value = 0xFFFFFFFF;
    public int DealMarker2 = 0x34; public uint DealMarker2Value = 0x076C0001;
    public int DealDate = 0x44, DealStatus = 0x55;
    public int DealRecordBytes => DealStatus + 1;

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
