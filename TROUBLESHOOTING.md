# TrueDoF troubleshooting

Everything TrueDoF writes is in **`%LOCALAPPDATA%\TrueDoF\`**. Paste that into the Explorer
address bar. The files that explain problems:

| File | What it tells you |
|---|---|
| `status.json` | The last F8: `"state": "ok"` or `"error"`, the message, the FM version, `"versionVerified"` |
| `diagnostics.txt` | Details of the last F8: what was found in memory, class offsets, C++ class names, your tactic, sample players |
| `truedof.log` | A running log of the plugin (and the CLI reader) |
| `overlay.log`, `server.log` | The Director window and the chat app it started |
| `<FM27>\BepInEx\LogOutput.log` | BepInEx itself: did the plugin load at all? |

TrueDoF never writes to the game, so none of these problems can harm your save.

---

## 1. The launcher (`TrueDoF.bat`) stops with an [X]

| Message | What to do |
|---|---|
| Node.js is not installed | Install the **LTS** version from <https://nodejs.org>, then run `TrueDoF.bat` again |
| No .env file yet / no API key | Paste your key from <https://console.anthropic.com> after `ANTHROPIC_API_KEY=` in `.env` (Notepad opens it for you) and save |
| npm install failed | Check your internet connection and run `TrueDoF.bat` again |
| [!] The FM plugin was not found | Close FM and run `Install-Plugin.bat`. If FM lives somewhere unusual, set it first: `set FMDIR=D:\Games\Football Manager 27` in a terminal, then run the `.bat` from there |
| Building the overlay failed | Install the **.NET 8 SDK**. The browser version (`TrueDoF.bat browser`) works without it |

`Install-Plugin.bat` says **"Football Manager is running"**: close FM completely first. Windows
locks the plugin file while FM runs.

## 2. F8 does nothing in FM

1. **Is the plugin loaded?** Open `<FM27>\BepInEx\LogOutput.log` and search for `TrueDoF`. If
   it isn't there:
   - BepInEx isn't installed or didn't start. Check for `winhttp.dll` next to `fm.exe`.
   - Your antivirus may have quarantined `winhttp.dll`. Restore it and add an exception for
     the FM folder.
   - The plugin isn't in `BepInEx\plugins`. Run `Install-Plugin.bat`.
2. **Use the other trigger.** Click **↻ Refresh** in the Director window. It writes a
   `request.flag` file that the plugin checks every second, which works even when the F8 key
   isn't picked up.
3. **F8 is taken?** Change `DumpHotkey` in `<FM27>\BepInEx\config\com.truedof.plugin.cfg` (e.g.
   `Ctrl+F8`). It applies at the next dump, with no restart needed.
4. **Backup reader without BepInEx:** with your save loaded, run `cli\bin\publish\TrueDoF.Cli.exe`
   (build it once with `dotnet publish cli -c Release`). It reads FM from outside and writes
   the same files.

## 3. F8 runs but `status.json` says "error"

| Message | Meaning / fix |
|---|---|
| "FM's game database (game_plugin.dll) isn't loaded yet" | You're in the main menu or FM is still starting. Load your save, then press F8 |
| "…% of FM's memory could not be read" | FM was busy (processing, saving) or low on RAM. Wait until FM is idle and try again |
| "No players found in memory" | Save not fully loaded, or **an FM patch moved things**: see section 7 |
| "Could not find you (the human manager) in memory" | Same: probably an FM patch (section 7) |
| "Found your manager but not a club" | You are unemployed in this save, or the contract offsets moved (section 7) |
| "Unexpected error …" | Details are in `diagnostics.txt` (look for `EXCEPTION`). Your previous dump was kept |

A failed F8 never overwrites your last good data.

## 4. The Director chat

| Problem | Fix |
|---|---|
| "Your Anthropic API key was rejected" | Check the key in `.env` (no spaces or quotes), then restart `TrueDoF.bat` |
| "too many requests or out of credit" | Check your credit at console.anthropic.com |
| "Port 8766 is already in use" | TrueDoF is already running (close the other window), or set `PORT=8767` in `.env` |
| "No game data yet" | Press F8 in FM with your save loaded |
| He talks about old data | Press F8 (or ↻ Refresh) after changes in FM; the header shows when the data was read |
| "The league table is not available" | `diagnostics.txt` has a "League table: …" line with the reason. Off-season (no league running yet) is normal; after an FM patch, see section 7 |

## 5. The Director window (overlay)

- **Hidden behind FM:** FM is using exclusive fullscreen. Switch FM to windowed or borderless:
  Preferences → Audio & Visual → Screen Resolution and Mode. (FM27's normal "Fullscreen" was
  tested and works; it is borderless.)
- **F9 does nothing:** another program uses F9. The window title then says "F9 is taken by
  another program". Close that program, or use the window without the hotkey.
- **"WebView2 Runtime is missing":** install it from
  <https://go.microsoft.com/fwlink/p/?LinkId=2124703> (Windows 11 normally has it).
- **"Could not start the chat app":** see `server.log`. Usually Node.js is missing or `.env` is
  wrong.
- **Window off-screen after changing monitors:** delete `overlay.json` and it starts at the
  right edge of your main screen.

## 6. Your tactic

- **Settings → Your tactic says "not read from memory yet":** FM writes your tactic when you
  **leave the tactics screen**. Open it, leave it, then press F8.
- **FM's tactic differs from `tactic.txt`:** the chat uses `tactic.txt` when it exists. Fix the
  file, or delete it to let TrueDoF follow FM. If you keep several tactics in your save,
  TrueDoF picks the one holding most of your current players; `diagnostics.txt` lists them
  (`selection @…`).
- **A role shows as "bit N" / "unknown role":** FM's code for that role has no name yet.
  1. Look in FM's tactics screen for which role that slot has.
  2. Find the slot in `diagnostics.txt` (`slot N: … (bit N, mask …)`).
  3. Add the bit to `InPossessionRoles` or `OutOfPossessionRoles` in `core/Layout.cs`.
  4. Rebuild the plugin.
- **Positions look off when there's no `tactic.txt`:** FM doesn't store positions (DL, AM(R)…),
  so TrueDoF guesses them from each role and player. Write a `tactic.txt` for exact positions.

---

## 7. It broke after an FM patch

**What happens:** FM keeps its data at fixed distances ("offsets") inside its objects. A patch
can move some of them. TrueDoF then finds nothing, or wrong numbers. Nothing is damaged. All
offsets live in one file, **`core/Layout.cs`**, so a fix is usually a few numbers. The steps
below use the evidence TrueDoF writes for this case.

### Step 1: confirm it's a version problem

Open `status.json`:
- `"gameVersion"` is the new FM version (e.g. `27.2.0.0`).
- `"versionVerified": false` means TrueDoF hasn't been checked on this version. The dump also
  carries the note "This FM version … is not verified".

If the numbers in the chat still look right, just add the new minor version to `VerifiedMinors`
in `core/Layout.cs` (`{ 0, 1 }` → `{ 0, 1, 2 }`) and rebuild. Done.

### Step 2: the class-offset histogram (players, staff, you)

TrueDoF recognises players by a number fixed per C++ class, the int at `[vtable-8]+4`. In
`diagnostics.txt`, under **"Class offsets seen"**, you'll see each number with how many objects
use it. For FM27 it expects player `0x288`, player+staff `0x380`, staff `0x100`, human manager
`0x440`.

After a patch, read the new numbers off the peaks:
- **staff** is the biggest peak;
- **players** are the second;
- **player+staff** is about 5–10% of the players;
- **you** (the human manager) is a tiny peak of 1–2 objects.

Each class often shows as a pair of peaks 0x28 apart. Put the new values into `PlayerClass`,
`PlayerStaffClass`, `StaffClass` and `HumanManagerClass` in `core/Layout.cs`. (FM26 → FM27 only
moved the human manager, `0x450` → `0x440`.)

### Step 3: the C++ class names

Under **"Most common C++ classes on the heap"** TrueDoF lists class names read from the game's
type information, e.g. `.?AVACTUAL_PLAYER@db@@`, `.?AVTEAM@db@@`, `.?AVFULL_CONTRACT@db@@`.

Names don't change when offsets move, so:
- **The list is there and looks normal:** the scan itself works, and only offsets inside
  objects moved (steps 4–5).
- **The list is empty or rubbish:** the scan's basics changed (rare). See step 6.
- **The tactic:** the header line says how many `PREPARED_TACTICS_CREATOR_ARRAY` objects
  were found.
  - **None:** the class was renamed.
  - **Found, but the "selection @…" lines show 0/11 of our players:** the person id offset
    (`PersonId`) or the slots offset (`SelSlots`) moved.
  - **The roles look wrong:** check `TacInPossession`, `TacOutOfPossession` and `TacSlotSize`.
- **The league table:** `diagnostics.txt` has a "League table: …" line saying where it stopped
  (no running competition, no league stage, or rows whose numbers don't add up). The path is
  `CompActual` → `ActualStages` → `StageRows` → `RowTeam` / `RowOverall` / `RowHome` / `RowAway` in
  `core/Layout.cs`. To re-find it: in `classes.txt`, take an `ACTUAL_COMP@sicomps` or
  `LEAGUE_STAGE@sicomps` address and dump it with `ProbeInspect = 0x…` (README, "The probe").

### Step 4: compare sample players with FM

At the end of `diagnostics.txt`, **"Sample squad players"** lists a few of your players: age, CA/PA,
positions, wage, contract end, morale. Open the same players in FM:
- **Ages or names wrong:** person-block offsets (`FirstName`, `DateOfBirth`…).
- **CA/PA or attributes wrong (e.g. all 0 or nonsense):** player-block offsets (`Ca`, `Pa`,
  `Attrs`, `Positions`).
- **Wage or contract wrong:** contract offsets (`ConWage`, `ConExpiry`…). Wages are in pounds
  (×≈1.16 for euros).
- **Finances wrong:** the `Fin…` offsets. The **probe** (README, "The probe") finds where a
  number you know (your balance) sits now.

### Step 5: re-check the open-source editors

Others usually re-find the offsets within days of a patch. TrueDoF uses only their documented
numbers (see `docs/credits.md`). Update the read-only copies in the git-ignored `reference/`
folder and compare:

```bash
git -C reference/fmsuperscout pull     # FMSuperScout (MIT): core/Fields.cs, docs/repin-guide.md
git -C reference/fmlibreeditor pull    # FMLibreEditor (GPL-3.0): profiles/fm27/layout.toml, docs/recon/
```

(First time: `git clone --depth 1 https://github.com/mavarobli/FMSuperScout reference/fmsuperscout`,
and likewise `https://github.com/tozmoz/FMLibreEditor reference/fmlibreeditor`.)

Also check FM OpenEditor (`ElMariones/FM_EDITOR`), `barak14/fm-editor` and
`Jackhamerp24/Football-Manager-27-Editor`, which keeps a per-build offset file. Copy changed
**numbers** into `core/Layout.cs`, never their code. Note where each came from.

### Step 6: rebuild and verify

```bash
dotnet run --project tests/SelfTest -c Release     # must say ALL SELF-TESTS PASSED
npm test                                            # must say fail 0
```

Then close FM, run `Install-Plugin.bat`, start FM, load your save, press F8 and compare with
FM's screens again (step 4). When it matches, add the new version to `VerifiedMinors`.

**Using Claude Code for this:** open the project and ask:

> FM was patched to version X and TrueDoF broke. Read TROUBLESHOOTING.md section 7,
> diagnostics.txt and status.json in %LOCALAPPDATA%\TrueDoF, then find the new offsets.

On Windows it can run the CLI reader against your running game to check.
