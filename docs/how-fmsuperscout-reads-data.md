# How FMSuperScout reads Football Manager's data

Study notes on the reference project <https://github.com/mavarobli/FMSuperScout>,
commit `6f58929` (22 Nov 2026), cloned read-only into `./reference/` (git-ignored).
We learn from it; every line of TrueDoF is written from scratch.

> **License note.** The brief assumed the repo has no license. It does now: an **MIT
> LICENSE** file (© 2026 mavarobli). That means reuse would legally be allowed with
> attribution. We still follow the original rule (we write our own code) because it keeps
> the project simple and fully ours, and it costs us little.

---

## TL;DR in plain language

1. **It doesn't "ask" the game for data. It reads the game's memory directly.** It goes
   through all of FM's memory, looking for things shaped like players, staff and clubs,
   and then reads the numbers at fixed distances ("offsets") from the start of each object.
2. **The IL2CPP/Unity layer is basically skipped.** FM's actual database (players, clubs,
   contracts) lives in a **native C++ module called `game_plugin.dll`**, not in the C#
   code Unity generated. The C# "interop bindings" BepInEx makes can't see inside it. The
   plugin uses BepInEx only as a way to get loaded into the game and to catch the hotkey.
3. **Every read is crash-proof.** Reads go through Windows' `ReadProcessMemory`. If an
   address is wrong it returns "failed" and the game is untouched. Nothing is ever written.
4. **A dump scans the whole heap (5–20 s) on a background thread.** That works because
   it never touches live game objects through game code. It just copies bytes.
5. **FM patches are handled by a version table.** It reads the version number of
   `game_plugin.dll` and picks a matching table of offsets. On an unknown version it shows
   a warning and writes repair hints into `diagnostics.txt`.
6. **It does NOT read finances, budgets, the league table, morale, or FM's in-game
   shortlist.** TrueDoF needs to find those itself. This is the biggest gap (see §7).

---

## 1. How it reaches game data: raw memory, not interop bindings

**Confirmed from source** (`core/MemScan.cs`, `core/MemScan.Win.cs`, `core/Dumper.cs`):

- `plugin/FMSuperScout.csproj` *references* the generated interop DLLs (`FMGame.dll`,
  `FM.UI.dll`, `SI.Core.dll`, …). The code **never uses a single game class from them**.
  The only IL2CPP APIs it touches are `ClassInjector.RegisterTypeInIl2Cpp`, plus Unity's
  `GameObject`/`MonoBehaviour` and `UnityEngine.InputSystem.Keyboard` for the hotkey.
- All data comes from `ReadProcessMemory` (P/Invoke to `kernel32.dll`), called on the
  plugin's *own* process (`GetCurrentProcess()`). The same core also runs as an external
  `.exe` that opens `fm.exe` with read-only rights.

### The scan, step by step

1. **List the readable memory.** `VirtualQueryEx` walks the address space and keeps
   regions that are committed, private and read/write (the heap). It skips guard and
   no-access pages and regions over 512 MB.
2. **Find the two modules.** It finds `GameAssembly.dll` (Unity C# code) and
   `game_plugin.dll` (native DB) in the process module list. Both get copied into a
   local byte array once, so later lookups don't need a system call.
3. **Hunt for vtables.** It reads the heap in 32 MB chunks across up to 8 threads. Every
   8-byte value that points *into* one of the two modules is a candidate "vtable
   pointer", meaning the first field of a C++ object.
4. **Classify by the MSVC RTTI trick.** For a vtable `vt` it reads `meta = [vt − 8]` and
   then the `int32` at `meta + 4`. In MSVC's C++ runtime that number is the distance
   from this sub-object to the start of the full object, and it's fixed per class. So it
   works as a class fingerprint:

   | `meta+4` value | Meaning | FM26 | FM27 |
   |---|---|---|---|
   | `PLAYER_OFFSET` | pure player | 0x288 | 0x288 |
   | `PLAYER_STAFF_OFFSET` | player who is also staff | 0x380 | 0x380 |
   | `STAFF_OFFSET` | non-player (staff) | 0x100 | 0x100 |
   | `HUMAN_MANAGER_OFFSET` | **you** (human manager) | 0x450 | **0x440** |

   Where the vtable was found is the "person" block. The player block sits at
   `person − offset`.
5. **Sanity checks.** A unique ID at `+0x0C` must not be 0 or `0xFFFFFFFF`, and CA/PA
   must be 1..200. Otherwise the object is skipped.
6. **Clubs are recognised by shape**, not vtable. A club is an object with a
   `std::vector` of 1–64 team pointers at `+0x18/+0x20` and a plausible Latin-script
   name string at `+0xC0`.

### FM's string format

- **Nested string:** `[addr] → outer`, `[outer] → inner`, UTF-8 text at `inner + 4`.
  Used for person names.
- **Indirect string:** `[addr] → p`, UTF-8 text at `p + 4`. Used for club, nation and
  competition names.

### FM's date format

A `uint32`: **year in the high 16 bits, day-of-year in the low 9 bits**.
`0xFFFFFFFF` and years before 2000 mean "not set".

---

## 2. Where each kind of data lives

FM has no single "database manager" singleton that this project uses. Everything is
found by the heap scan and then reached by **following pointers** between objects.

| What we want | How FMSuperScout gets it | Notes |
|---|---|---|
| **Player database** | Heap vtable scan (§1) | ~50k–300k players depending on loaded leagues |
| **Human manager** | Object whose class offset = `HUMAN_MANAGER_OFFSET` | Network saves can have several |
| **Manager's club** | Walk every club → team → `[team+0x80]` = team manager. If that equals our manager, it's our club. Fallback: manager → contract → team → club | First team = team type 0 |
| **Squad** | Club teams vector `[club+0x18..0x20)` → each team's player vector `[team+0x38..0x40)` | Entries sometimes aren't direct person pointers; it probes `+0x00..+0x80` for one |
| **Contract** | `[person+0xA8]` → contract object | wage `+0x20` (u32, GBP/week), expiry `+0x48` (FM date), squad number `+0x5D`, status flags `+0x57`, team `+0x10`, job `+0x26` |
| **Transfer status** | contract flags byte `+0x57` | bit0 listed, bit3 listed by request, bit4 not for sale, bit5 set for release, bit1 loan-listed (unverified) |
| **Club name / league** | club `+0xC0` (name), `+0xC8` (short). League: `[team+0x50]` or `[team+0x60]` → competition, name `+0x40`, short `+0x48` | |
| **Club reputation** | `team+0xA8` (u16, ~0..10000) | Read from the team, not the club |
| **Transfer activity** | A separate **deal table** with 0xC8-byte records and no vtable, recognised by fixed marker values (`+0x2C = 0xFFFFFFFF`, `+0x34 = 0x076C0001`) | person `+0x00`, buying team `+0x08`, selling team `+0x18`, date `+0x44`, status `+0x55` (0x14 done, **0x13 agreed**, 0x0F rejected). The fee field is unreliable, so they skip it |
| **In-game date** | `[myTeam+0xA0]` → schedule, next match date at `+0x94` (or `+0x18`) | Can run up to 2 weeks ahead during breaks |
| **Finances (balance, budgets, wage bill)** | **Not read** | Wage bill can be *computed* from squad wages |
| **League table** | **Not read** | Only the league *name* |
| **FM's in-game shortlist** | **Not read.** The app's "shortlist" is its own. `.fmf` export files are encrypted (`docs/fmf-format.md`) | |
| **Morale** | Offset defined (`PLAO_MORALE = 0x26C`, byte) but **never used or verified** | Same for condition `0x258` |

---

## 3. Attributes, CA/PA and hidden attributes: how they're stored

All offsets below are from the **player block** (`pl = person − PLAYER_OFFSET`) unless
marked *person*.

- **CA** = `u16` at `pl+0x264`, **PA** = `u16` at `pl+0x266`. These are the true values
  (1–200), with no scaling. In FM's editor, a negative PA (−5…−95 "range") is a database
  seed; in a running save the player block holds the resolved number.
- **Reputation:** home `+0x25E`, current `+0x260`, world `+0x262` (u16).
- **Height** `+0x22E` (u16, cm). **Value** `+0x234` (u32 GBP; `0xFFFFFFFF` or
  `300,000,000` = unknown). **Asking price** `+0x238`.
- **Positions:** 15 bytes at `+0x150`, each 0..20 (20 = natural). Order: GK, SW, DL, DC,
  DR, DM, ML, MC, MR, AML, AMC, AMR, ST, WBL, WBR. "Accomplished" is ≥ 15.
- **Attributes: 1 byte each, stored ×5** (so Pace 18 is the byte `90`), starting at
  `pl+0x15F`. They convert with `round(raw / 5)`, clamped to 0..20. There are 47 visible
  attributes at fixed sub-offsets. A few examples: Crossing `+0x00`, Finishing `+0x02`,
  Passing `+0x07`, Decisions `+0x12`, Acceleration `+0x22`, Pace `+0x26`,
  Determination `+0x33`. Goalkeeper attributes sit in the same block (Handling `+0x0B`,
  Reflexes `+0x15`, …).
- **Footedness** is in the same ×5 block: left `+0x18`, right `+0x19`.
- **Hidden playing attributes (also ×5, same block):** Dirtiness `+0x29`,
  **Consistency `+0x2C`**, **Important Matches `+0x2F`**, **Injury Proneness `+0x30`**,
  Versatility `+0x31`.
- **Hidden personality (on the *person* block, raw 1..20, NOT ×5):** Adaptability
  `+0x70`, **Ambition `+0x71`**, Loyalty `+0x72`, Pressure `+0x73`,
  **Professionalism `+0x74`**, Sportsmanship `+0x75`, Temperament `+0x76`,
  Controversy `+0x77`.
- **Identity (person):** first/second/common name at `+0x50/+0x58/+0x60` (nested
  strings; common name wins), nation `[+0x68]` → name `+0x20`/`+0x30`, date of birth
  `+0x88` (FM date). Gender is bit `0x10` of byte `+0x19` (set = female).
- **Money is always GBP** internally, whatever currency your FM shows. Wages are weekly.

**Quirk:** a value of 0 after `round(raw/5)` usually means the read missed. Real
attributes are 1–20.

---

## 4. Hotkey, threading and crash-avoidance

- **Hotkey:** `Load()` registers a custom `MonoBehaviour` with
  `ClassInjector.RegisterTypeInIl2Cpp<…>()`. It's attached to a hidden `GameObject` marked
  `DontDestroyOnLoad` + `HideAndDontSave`. Each frame `Update()` checks
  `Keyboard.current[Key.F9].wasPressedThisFrame` (Unity's new Input System). The key is
  hard-coded, not configurable.
- **Known flakiness:** their own comment says the injected `MonoBehaviour` sometimes
  **never ticks** in some sessions. So they added a second trigger: a background thread
  that polls for a `request.flag` file once a second (with a staleness check, so an old
  flag can't fire during FM start-up).
- **Threading:** the hotkey only *starts* the dump. The scan runs on `Task.Run` (a
  background thread). This is safe for them because they never call game code. They only
  copy bytes through `ReadProcessMemory`, which is thread-safe, and IL2CPP's garbage
  collector doesn't move objects. Only one dump can run at a time (an `Interlocked` flag
  plus a named mutex shared with the external scanner).
- **Crash safety, in layers:**
  1. No raw pointer dereferences, ever. Every read can fail and return 0.
  2. Bounds checks written to avoid integer wrap-around (they had a real crash from a
     corrupt pointer near `ulong.MaxValue`, issue #16).
  3. `try/catch` per memory region. One bad region is logged and skipped, not fatal.
  4. A `try/catch/finally` around the whole dump writes `status.json` with
     `"state":"error"`, so the UI never hangs on "scanning".
  5. **Refuses to overwrite a good dump with a bad one.** If 0 players are found, or more
     than 10% of memory was unreadable, the existing file is kept.
  6. If `game_plugin.dll` isn't loaded yet (main menu or start-up), it aborts with a
     friendly message.
  7. If more than 10% of memory can't be read live, it retries from a frozen
     copy-on-write snapshot (`PssCaptureSnapshot`).
  8. Files are written atomically: write to `.tmp`, then `File.Move`, retried while
     antivirus or another reader has the file locked.
  9. Memory-aware: it uses fewer worker threads when free RAM is under 2 GB, and frees
     big buffers afterwards.

---

## 5. Handling FM patches and new versions

- `core/Fields.cs` holds a **layout object per FM edition**: FM26 (verified on 26.3) and
  FM27 (verified on 27.0 and 27.1). FM27 is "FM26 with one change": the human manager
  class offset moved from `0x450` to `0x440`.
- At dump time it reads the **file version of `game_plugin.dll`** (`FileVersionInfo`).
  The major version picks the layout. If the minor version isn't in `VerifiedMinors`, it
  sets `versionOk:false` in the dump, and the app shows an amber warning.
- On a version mismatch, `diagnostics.txt` gets a **REPIN-HINTS** section and a
  **histogram of every class offset seen**. Their `docs/repin-guide.md` explains how to
  read it. Each class shows up as a pair of peaks exactly 0x28 apart. Staff is the
  biggest peak, players are second, player-staff is ~5–10% of players, and the human
  manager is a tiny peak of 1–2.
- What moves most often: the class offsets. Then player-block fields (CA/PA, attributes).
  Person, contract and club fields rarely move.
- In-game sanity check after a re-pin: compare a squad screen in FM against the dump
  (age, contract, nationality, wage ×≈1.16 for €).

**Takeaway for TrueDoF:** the vtable scan is designed to survive patches. A patch usually
means updating a handful of numbers in one file, guided by diagnostics. We'll copy that
*idea* (version table, histogram diagnostics, "keep the old dump on failure").

---

## 6. Project setup (build and deploy)

- **SDK-style csproj, `net6.0`** (BepInEx 6 IL2CPP runs on .NET 6). `AllowUnsafeBlocks`
  is on, `Nullable` is off, `DebugType none` (so the user's build path doesn't leak into
  the DLL). Dependency files are disabled, and all references use `Private=false` so only
  our own DLL is output.
- **References** are hard paths into the game folder:
  - `BepInEx\core\`: `BepInEx.Core.dll`, `BepInEx.Unity.IL2CPP.dll`,
    `Il2CppInterop.Runtime.dll`, `Il2CppInterop.Common.dll`, `0Harmony.dll`.
  - `BepInEx\interop\` (generated by BepInEx on the first game launch):
    `Il2Cppmscorlib.dll`, `UnityEngine.CoreModule.dll`, `Unity.InputSystem.dll`, plus
    FM's own DLLs (unused).
  - Default game path:
    `C:\Program Files (x86)\Steam\steamapps\common\Football Manager 26\`.
- **Compiler gotcha they hit:** the IL2CPP reference assemblies contain a stripped
  `NullableAttribute`. Anything that makes the C# compiler emit one breaks the build: C#
  `record` types, `with` expressions, and lambdas passed to `Parallel.ForEach` or
  `Timer`. They avoid all of these and use parameterless lambdas with `Task.Run` or
  `Thread`.
- **Plugin entry:** a class `: BasePlugin` with `[BepInPlugin(id, name, version)]` and a
  `Load()` override.
- **Build/deploy:** `dotnet build` → copy `FMSuperScout.dll` into
  `<FM>\BepInEx\plugins\`. Output and logs go to `%LOCALAPPDATA%\FMSuperScout\`
  (`dump.json`, `status.json`, `diagnostics.txt`).
- **Important history:** since v1.6.0 **they no longer ship the BepInEx plugin**. They
  moved to an external `.exe` scanner that runs the same core against `fm.exe` from
  outside. Reasons from their TROUBLESHOOTING: antivirus quarantining BepInEx's
  `winhttp.dll`, a very slow first launch (interop generation), and F9 going dead after FM
  relaunched itself. In their repo the plugin is now "legacy, FM26".

---

## 7. What this means for TrueDoF (my recommendations)

1. **Use the same approach: raw, read-only memory reads with a version table.** Interop
   bindings can't reach `game_plugin.dll`, where the data lives.
2. **We can make it much smaller.** We only need our club and a few players. We still
   need one heap scan to find the human manager and build an address → player map (for the
   squad and transfer lookups). But we only *read details* for ~30–80 people, not 300k,
   and we write a small JSON instead of 600 MB.
3. **Threading needs a decision (it clashes with a hard rule).** "All game-object access
   on the main thread" would freeze FM for the 5–20 s scan. FMSuperScout's approach (copy
   bytes off-thread with `ReadProcessMemory`, never call game code) still honours the
   *reason* behind the rule: we never touch live game objects through the game's own code,
   so there's nothing to race with. I recommend: hotkey and Unity calls on the main
   thread; byte-copy scan, JSON and files on a background thread.
4. **Finances, the league table, morale and FM's shortlist aren't solved by anyone yet.**
   We can't discover offsets without the game running, and I can't run FM here. Plan:
   ship Phase 1 with everything the reference has already mapped. Wage bill is computed
   from contracts. Add a **"probe" mode** that writes candidate values near the club and
   team objects into `diagnostics.txt`, so you can match them against your in-game
   finance screen and league table. Shortlist: until we find it in memory, fall back to a
   small `shortlist.txt` (player names you type in). The plugin looks those players up in
   the scanned database.
5. **Hotkey robustness:** use the injected `MonoBehaviour` like they did. Also add a
   tiny background poll of `GetAsyncKeyState(F8)` (Windows API, gated on FM being the
   foreground window) as a fallback, because their `Update()` sometimes never ran.
6. **Copy the safety ideas:** atomic file writes, keep the last good dump on failure,
   `status.json` with error text, version check plus histogram in `diagnostics.txt`, and
   abort while `game_plugin.dll` isn't loaded.
