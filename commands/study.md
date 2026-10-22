---
description: Study clock - clock in or out, see today's block, streak and weekly hours, plan a study checklist, or change your study block time.
argument-hint: [in [topic] | out [notes] | status | plan | block HH:MM-HH:MM | goal <hours>]
---

Study: `$ARGUMENTS`

CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (written `jh` below). The dashboard at `http://127.0.0.1:4777/` has the same clock with a live timer.

Defaults: one block "Morning study" 05:30-08:00 every day, 30 minutes of grace (a 06:00 start is on time), sessions auto-close at 240 minutes, a day counts toward the streak at 60 minutes, weekly goal 15 hours.

## Subcommands

- **`in [topic]`**: `jh study in --topic "<topic>" --json`. Exit 2 with `already_clocked_in` means a session is open: show it from `jh study status --json` and offer `out`.
- **`out [notes]`**: `jh study out --notes "<notes>" --json`. If `auto_closed` is 1, say the session hit the 4-hour cap. Then offer to tick off tasks done this session: `jh study task done <id> --json`.
- **`status`** (default): `jh study status --json`. Show: clocked in or not (with elapsed time), today's block state (`upcoming`, `in_progress`, `done`, `missed`) and on-time flag, today's minutes, streak, week minutes vs goal with percent, open tasks.
- **`plan`**: build today's checklist.
  1. `jh interview list --upcoming --days 14 --json`: technical or assessment rounds suggest topics (from the role and any prep pack's "Likely questions").
  2. `jh study task list --json`: keep unfinished tasks.
  3. Propose 3-5 tasks that fit the block (about 30-45 minutes each). Add each with `jh study task add "<title>" --for <YYYY-MM-DD> --json`.
- **`block HH:MM-HH:MM`**: change the study window, for example `block 06:00-08:00`.
  `jh study blocks list --json` → take the active block (ask which if several), then `jh study blocks edit <id> --start 06:00 --end 08:00 --json`. Add a second block with `jh study blocks add --label "Evening" --days 1,2,3,4,5 --start 20:00 --end 21:00 --json`.
- **`goal <hours>`**: `jh study set weekly_goal_hours <hours> --json`. Other settings: `grace_minutes`, `streak_min_minutes`, `max_session_minutes`, `timezone` (IANA name, for example `jh study set timezone Asia/Kolkata --json`).

Keep the reply to a few lines. Encourage, never nag: a missed block is reported plainly with the next block's time.
