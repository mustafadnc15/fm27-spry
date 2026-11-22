# Credits: where TrueDoF's memory offsets come from

TrueDoF's code is written from scratch. The offsets it uses are facts about Football
Manager's memory layout, and those facts were documented by others first. Thank you to:

| Project | License | What we learned from it |
|---|---|---|
| [mavarobli/FMSuperScout](https://github.com/mavarobli/FMSuperScout) | MIT | Heap scan by vtable/RTTI class offset; person, player, contract, team, club, competition and transfer-deal layouts |
| [tozmoz/FMLibreEditor](https://github.com/tozmoz/FMLibreEditor) | GPL-3.0 | FM27 club finance record (balance, transfer budget, wage budgets), morale scale |
| [ElMariones/FM_EDITOR](https://github.com/ElMariones/FM_EDITOR) (FM OpenEditor) | GPL-3.0 | Confirms the finance record at club+0x150 and its fields, plus the hidden attributes and personality order |
| [barak14/fm-editor](https://github.com/barak14/fm-editor) | GPL-3.0 | Morale byte at +0x26C with FM's labels; the warning that small clubs use a smaller finance record |
| [Jackhamerp24/Football-Manager-27-Editor](https://github.com/Jackhamerp24/Football-Manager-27-Editor) | GPL-3.0 | Per-build offset files that confirm the same finance offsets |

No code from these projects is copied into TrueDoF; they were cloned read-only into the
git-ignored `reference/` folder for study.
