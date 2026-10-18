# usage-bars

A Claude Code mod that shows four meters in one line right above the prompt box:

| Meter | What it measures | Alternative text |
| --- | --- | --- |
| **Ctx** | context of the current session in use | used · total tokens |
| **Cch** | time left before the prompt cache expires | minutes left · what the next prompt costs for the context now → once the cache has expired (input-token equivalents: 0.1× read, 2× rewrite) |
| **Ses** | the account's 5-hour usage window | time to reset (`-2h 30m`) · reset time |
| **Wk** | the account's weekly limit | time to reset · reset day and time |

- Each bar keeps its own colour. The value beside it follows a scale: yellow from 75%, orange bold from 85%, red bold from 95%. For the cache the scale reads the time already gone, so it turns yellow with 15 minutes left.
- Hovering a bar shows its alternative text, in two lines. A click on the bar or its label pins it; another click unpins it. Hovering a pinned text shows it in full.
- Hovering a label (Ctx, Cch, Ses, Wk) shows its full name in the graph's place.
- In the red band a meter shows its alternative text by itself.
- On the desktop the bars are thin SVG pills; in the terminal, blocks of colour.

Session and week figures arrive with each API response. Every session with the mod writes its latest reading to `~/.claude/usage-bars/latest.json` and, every 30 seconds, takes a fresher one another session wrote: an idle session shows what an active one saw, and the verbose text says how old the reading is. The file is written whole beside it and moved over it, so no session reads it half written, and an older reading never replaces a fresher one. Past its reset time a window shows `0%` until a new reading arrives. The cache lifetime is assumed to be 1 hour; the time of each session's last response is kept in the mod's store, so a resumed session picks up its countdown.

## Install

At the prompt of a terminal session:

```
/plugin install usage-bars --marketplace luismiggarcia/claude-usage-bars
```

From a shell:

```bash
claude plugin install usage-bars --marketplace luismiggarcia/claude-usage-bars
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `luismiggarcia/claude-usage-bars`, then **Add plugin**.

Installed at the user scope, it loads in every new session.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

---

© LG-Systems
