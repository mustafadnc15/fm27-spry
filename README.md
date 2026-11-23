# TrueDoF: an AI Director of Football for Football Manager 27

TrueDoF reads the **true** data of your FM27 save (real attributes, CA/PA, hidden
attributes, contracts) straight from the game's memory. An AI "Director of Football" then
reasons from that data instead of scout-report guesswork.

Status: **Phases 1 and 2 are done and verified in-game. Phase 3 (the Director chat) is built
and waiting for your test.** The one-click launcher (Phase 4) comes next.

Rules TrueDoF follows:

- **Read-only.** It never writes to the game's memory and never touches your save files.
- **Single-player only.**
- **It can't crash FM.** Every memory read can fail harmlessly. Errors go to
  `status.json` and `diagnostics.txt`.
- **One output folder:** `%LOCALAPPDATA%\TrueDoF\` (paste that into the Explorer address
  bar).

---

## Phase 1: install and test the plugin

### 1. Install BepInEx 6 into FM27 (one time)

1. Download the newest **BepInEx 6 "bleeding edge" build** for **Unity IL2CPP, Windows
   x64** from <https://builds.bepinex.dev/projects/bepinex_be>. The file is named like
   `BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.7xx+….zip`. FM27 runs on Unity 6, so take a
   recent build.
2. Open your FM27 folder: Steam → right-click Football Manager 27 → Manage → Browse local
   files. It's the folder that contains `fm.exe`.
3. Extract the zip **into that folder**. You should now see `winhttp.dll`,
   `doorstop_config.ini` and a `BepInEx` folder next to `fm.exe`.
4. Start FM27 once and wait. **The first start can take several minutes** while BepInEx
   prepares itself. Once you reach the main menu, quit FM.
5. Check that `BepInEx\LogOutput.log` exists and that there's a `BepInEx\plugins` folder.

> Antivirus software sometimes quarantines `winhttp.dll`. If BepInEx doesn't start,
> check your antivirus quarantine and add an exception for the FM folder.

### 2. Build TrueDoF (one time, and again after each update)

1. Install the **.NET 8 SDK** from <https://dotnet.microsoft.com/download> (the "SDK",
   not just the "Runtime").
2. Open a terminal **in this project folder** and run:

   ```bash
   dotnet build plugin -c Release
   ```

3. If FM27 is in the default Steam folder, the build **copies `TrueDoF.dll` into
   `BepInEx\plugins` automatically**. You'll see `TrueDoF.dll copied to …`. If FM27 is
   somewhere else, either:

   ```bash
   dotnet build plugin -c Release -p:FMDir="D:\Games\Football Manager 27"
   ```

   or copy `plugin\bin\TrueDoF.dll` into `<FM27>\BepInEx\plugins\` yourself.

### 3. Use it

1. Start FM27 and load your save.
2. Wait until FM is idle (not "processing"), then press **F8** on any screen.
3. Within about 5–30 seconds, `%LOCALAPPDATA%\TrueDoF\` will contain:

| File | What it is |
|---|---|
| `status.json` | `"state": "ok"` or `"error"` with a message, plus the timestamp and game version |
| `dump-latest.json` | Your club, squad, shortlist and transfer activity (an example is in `docs/examples/dump-sample.json`) |
| `diagnostics.txt` | Technical details for troubleshooting |
| `shortlist.txt` | **Your shortlist: type player names here**, one per line |
| `truedof.log` | A running log |

**Shortlist:** TrueDoF can't read FM's own shortlist yet, so type your targets into
`shortlist.txt` and press F8 again:

```
Erling Haaland
Haaland @ Man City
uid:12345678
```

Add `@ Club` when two players share a name. Accents and capitals don't matter.

**Changing the hotkey or other options:** edit
`<FM27>\BepInEx\config\com.truedof.plugin.cfg`. That file is created on the first FM
start with the plugin. Changes apply at the next F8, with no FM restart needed.

### Backup: the external reader (if BepInEx won't work)

The same code also ships as a standalone program that reads FM from outside:

```bash
dotnet publish cli -c Release
```

Then, with FM27 running and your save loaded, run `cli\bin\publish\TrueDoF.Cli.exe`. It
writes the same files.

---

## Phase 2: the briefing

The briefing turns `dump-latest.json` into a short text summary of about 1,500–3,000
tokens. That's what the AI Director reads. It contains:

- finances and wage headroom;
- the best XI by CA (it tries 4-2-3-1, 4-3-3, 4-4-2 and 3-5-2 and keeps the strongest);
- depth per position and weak spots;
- contracts ending within 12 months;
- wage structure and morale;
- high-potential youth;
- verdict inputs for every shortlist player: upgrade or not, affordability, contract
  situation and character.

The maths is done by plain code, not by the AI, so the numbers are always right.

1. Install **Node.js LTS** from <https://nodejs.org> (one time).
2. Press F8 in FM so the dump is fresh.
3. In this project folder, run:

   ```bash
   node briefing/cli.js --print
   ```

   It prints the briefing and saves it as `%LOCALAPPDATA%\TrueDoF\briefing.txt`.

An example made from a test squad is in `docs/examples/briefing-sample.txt`. To run the
tests, use `npm test`. They include an end-to-end run of the chat app against a fake
Anthropic API, so no key or internet is needed.

---

## Phase 3: talk to your Director

A small web app on your own PC at <http://localhost:8766>. Each question goes to Claude
(Anthropic's AI, model **Claude Sonnet 5.5**) together with the briefing and the Director's
instructions. He has a club philosophy, argues with you, and gives every transfer target a
**SIGN / SCOUT FIRST / STRETCH / NO** verdict.

### One-time setup

1. Get an API key at <https://console.anthropic.com> → API Keys. The API is paid per use; a
   question typically costs about a cent.
2. In this project folder, copy `.env.example` to `.env`, open it in Notepad and paste your key
   after `ANTHROPIC_API_KEY=`. The `.env` file stays on your PC and is never uploaded.
3. Install the one dependency (Anthropic's official library), in this project folder:

   ```bash
   npm install
   ```

### Every time

1. Start FM27, load your save and press **F8** (or use **Refresh from FM** in the app later).
2. In this project folder, run:

   ```bash
   npm start
   ```

3. Open <http://localhost:8766> in your browser and ask away. Leave the terminal window open
   while you chat; close it to stop the app.

### He can search the whole player database

On every F8 the plugin also writes `players-db.json`: every player in the leagues loaded in
your save (tens of thousands). While answering, the Director can use four tools on it by
himself:

- **search players**: by position, age, ability, fee, wage, contract, league, nationality
  and transfer/loan list. Ask for a **starter** and he looks at or above your current first
  choice there. Ask for a **backup** and he looks at or a bit below. "Affordable" uses your
  transfer budget and wage room (free agents and players in their last 6 months count too).
- **find similar players**: alternatives to any player, compared on the attributes that
  matter for his position.
- **player profile**: everything about any player.
- **add to shortlist**: puts a player in your `shortlist.txt` (only when you ask). He gets a
  full report after the next refresh.

While he works you'll see notes like "Searching the player database: ST, starter,
affordable…". Searches follow the same view setting. In "What I see in FM" they rank by position
rating and never show CA or PA. In "Everything" they show and filter on true CA and PA. In
"Scouted estimates" they use his estimates. To switch the export off, set `ExportPlayerDatabase = false` in the plugin
config.

FM's own shortlists can't be read yet. Saved shortlist files are encrypted, and nobody has
found where FM keeps the shortlist in memory. So `shortlist.txt` (or "add him to the
shortlist" in the chat) is the way to go.

### Tell him your tactic

Put two plain text files in `%LOCALAPPDATA%\TrueDoF\`:

- `tactic.txt`: the name, the shapes with and without the ball, your style, your priority
  attributes and the 11 slots. A slot line is
  `<position with ball>-<position without ball> = <role with ball> / <role without ball>`:

  ```
  name: ZaZ - Ace of Diamonds 2.0
  formation: 4-1-2-3-0 / 5-2-0-3-0
  style: Gegenpress
  priority: pace, acceleration, stamina

  GK-GK  = Ball-Playing Goalkeeper / Sweeper Keeper
  DM-DC  = Defensive Midfielder / Centre-Back
  AM(C)-AM(R)  = Second Striker / Winger
  ```

- `wanted-player-attributes.txt` (optional): your own notes on which attributes the tactic
  needs. The Director reads them word for word, and TrueDoF turns lines like `Pace: 12-20++`
  (`++` top priority, `+` priority, `*` counts most above the low end) and
  "Minimum requirements: … Work Rate …" into scoring curves.
- `role-to-attribute.txt` (optional): a measured table of goals per season per attribute and
  position group (`Attribute Team ST AM WB CB DM`, `*` = confirmed). It drives most of the
  rating, and only confirmed values are used. Without it, TrueDoF uses the built-in copy of
  Purity's FM27 study ([FM-Arena thread](https://fm-arena.com/threads/attribute-importance-by-position-in-fm27-a-test-on-my-own-tactic.125/),
  `docs/engine-weights-study.txt`).
- `roles.txt` (optional): correct a role's highlighted attributes, one role per line:
  `Second Striker = key: Finishing, Off the Ball, Acceleration | pref: Dribbling, Composure`.

**Tactic rating.** With a tactic, the briefing's best XI fills your 11 slots, and the Director
rates every player per slot (1–20):
- the measured table (or, without it, your guide) for the tactic part;
- FM's highlighted role attributes for the rest, at 25% (40% without the table);
- multiplied by how familiar the player is with the slot's positions.

Add `role weight: 10` (a percent) to `tactic.txt` to change the role share. Ask him things like
"find me a cheaper option for slot 6" or "find me an inside forward for my tactic".

Where the role attributes come from: no full FM26/FM27 list is published.
- Four roles come from Passion4FM's FM26 guides: Advanced Wing-Back, Channel Midfielder,
  Overlapping Centre-Back and Screening CM.
- The forwards' key attributes come from FM26 coverage.
- Roles that existed in FM24 use FM24's highlights.
- Brand-new roles are TrueDoF's estimates.

Settings → Your tactic shows which source each of your roles uses.

The tactic shows up in the briefing ("What he sees") and in **Settings → Your tactic**, which
also lists any line TrueDoF didn't understand. Edits apply at your next question, with no
restart needed.

### Buttons and settings

- **Refresh from FM**: asks the plugin for fresh data, the same as pressing F8 in the game.
- **What he sees**: shows the exact briefing the Director reads.
- **Settings** → **What can the Director see?**
  - **What I see in FM** (default): exact attributes and personality, but no CA, PA or hidden
    attributes. That matches FM with attribute masking off. Players are compared by a
    **position rating** (1–20) that TrueDoF works out from the attributes that matter at each
    position, e.g. finishing, composure, off the ball and first touch for a striker.
  - **Everything**: true CA, PA, hidden attributes and attributes, in the briefing and in
    search results.
  - **Scouted estimates**: CA, PA and attributes become ranges. The worse his **judging
    ability** (1–20), the wider the ranges. The true value is always inside the range, and
    asking again doesn't change the estimate. He knows your own players better than other
    clubs'. Contracts, wages, ages and finances are never blurred.
- **Settings** → **How hard he thinks** (low, medium or high) and **Club philosophy** (the
  principles he holds you to).
- Your conversation is kept in your browser. **New chat** starts over.



| Data | Status |
|---|---|
| Club name, league, reputation, teams (first/reserves/youth) | ✅ |
| Squad: name, age, nationality, positions, all attributes, CA, PA | ✅ |
| Hidden: consistency, important matches, injury proneness, dirtiness, versatility | ✅ |
| Personality: ambition, professionalism, pressure, loyalty, temperament, … | ✅ |
| Contract: weekly wage, expiry, squad number, transfer/loan-listed flags | ✅ |
| Value, asking price, reputation, height, preferred foot | ✅ |
| Players on loan to you / loaned out | ✅ (loaned-out players show a note) |
| Wage bill | ✅ computed from player contracts, plus FM's own wage total |
| Transfer activity (completed / agreed deals involving you or your shortlist) | ✅ no fees |
| Morale | ✅ 1–20 plus FM's own word (10 = Okay, 13 = Good, 17 = Excellent, 18 = Superb, 19 = Exceptional, 20 = Perfect) |
| Balance, transfer budget, wage budget (weekly) | ✅ |
| League table | ❌ not mapped yet: use the probe |
| FM's own shortlist | ❌ use `shortlist.txt` |

Money is always **pounds (GBP)**. That's how FM stores it internally, whatever currency
you see in the game.

### The probe: helping TrueDoF find the league table

1. In FM, set the currency to pounds (Preferences → Units → Currency).
2. Note your **exact** balance, transfer budget and wage budget from the Finances screen,
   plus your points and goal difference from the league table.
3. Edit `<FM27>\BepInEx\config\com.truedof.plugin.cfg`:

   ```ini
   [Probe]
   ProbeEnabled = true
   ProbeValues = balance=2561896; transferBudget=40086; wageBudget=60989; points=59; goalDiff=43
   ProbeInspect = competition +0xE08 +0x1E8
   ```

   Numbers must be exact. Put `~` in front of one (for example `balance=~2.5M`, written
   as `~2500000`) only if FM shows it rounded.
4. Press F8. `probe.txt` shows where the numbers were found. The full list goes to
   `probe-all.txt`.
5. Play a match, so the numbers change. Update `ProbeValues` and press F8 again. Now
   `probe.txt` lists **CONFIRMED** places, meaning ones that held the old value before and
   the new value now. Those are the real fields.
6. `ProbeInspect` dumps one memory object with labels (team / club / player / text). Each
   `+0x…` is followed as a pointer.

---

## For developers

```
core/      all logic (memory reading, scanning, club dump, shortlist, probe, output)
briefing/  Phase 2: dump → briefing text, plus realism (Node.js, no dependencies)
server/    Phase 3: the Director chat web app (Node.js + Anthropic SDK), database search tools
plugin/    BepInEx entry point (TrueDoF.dll)
cli/       external reader (TrueDoF.Cli.exe)
tests/     self-test with a fake FM memory image (runs on any OS)
docs/      research notes and examples
```

Run the self-test with:

```bash
dotnet run --project tests/SelfTest -c Release
```

The memory layout is documented in `docs/how-fmsuperscout-reads-data.md`, and all offsets
live in `core/Layout.cs`. See `docs/credits.md` for where each offset came from.
