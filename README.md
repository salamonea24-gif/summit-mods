# Summit pack

Seven add-ons to the Claude app for running Summit Research from one place. Built 7 Nov 2026 for Anthony's Summit HQ.

**What it adds**

- **Waiting on you pane** (`/waiting`): every item that needs Anthony, with Approve, Hold, Decline and a reply box on each line and the back and forth kept on that line. It reads and writes the same rows as the "Waiting on Anthony" board (artifact TzN5k3GW1GvNuo67a7pxVK), through the ArtifactData tool, so there is one store and two views.
- **Delivery health** (`/health`): a status line showing whether Summit Daily, the Weekly free edition, Sentinel and the four social slots went out today, read from the PC's own logs (`ghost_send_log.txt`, `post_runner_log.txt`, the drafts and issues folders) or from `summit\workspace\ops\health.json` when the PC writes it. A line that goes bad raises a toast and a desktop notification once; a missed Summit Daily also becomes a line on the board.
- **Guardrail**: stops any touch of settings.ini, keys, the Indicators folder, the journal or positions, and payment or trading tools. Public sends, scanner code ships, Pine script changes and scheduled-task or house-rule edits are stopped until Anthony approves the matching line on the board (his own approval message, never a status another session wrote). The outside-the-Summit-folders rule reports only for its first day, then stops calls. `/guardrail` shows what it stopped. `/approve-once` is Anthony's manual release when the board cannot be reached.
- **Prepublish gate**: holds a social post or message whose words carry a retired product name, advice wording, UK spelling or no disclaimer.
- **Live corrections** (`/correct <one line>`): the correction is logged on the board, added to every new session's instructions at once, and one "Same-day skill update" line per affected skill is added for a watching session to draft. A band above the prompt shows how many are in force.
- **Twice-daily notice**: at 8:00 am and 6:00 pm ET, a desktop notification naming what needs Anthony most.
- **Scanner ship receipt**: under a change to a scanner code file, a card saying whether a backup from today exists and that start_scanner.bat needs a restart.

**Where things are read**: on the PC the pack reads the Stock Scanner folder directly; in a cloud thread it reads through folder access (`device_bash`). It never opens settings.ini. Paths and rules are in `hooks/config.ts`.

**Checks**: `claude plugin validate .` and `claude plugin test .` (16 tests on the guardrail, gate, health parsing of real log lines, corrections, board parsing and the pane).
