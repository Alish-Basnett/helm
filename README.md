# Helm

Mission control for Claude Code. Every session reports into one live board. You can see what each session and its subagents are doing, step into any subagent's thread, drop notes onto a task and run them, and get a short recap of every finished task so you keep learning.

- **Board**: Backlog · Up next · In progress · Review · Done, plus Saved for later and Blocked. Cards move on their own from engine events, not from the model remembering to update them.
- **Projects**: each session gets its own project. `/helm join <project>` (or "Move to project…" in the dashboard) brings another session into it.
- **Office**: every session is a desk with its subagents beside it, each showing a live "now doing" line, its model, cost, and a waiting or stalled state.
- **Threads**: a live graph of main agent → subagents. Step into one to see its brief, tool timeline, files and recap, and prompt it directly.
- **Notes + Execute**: add notes to a task or session. Execute sends them to a running subagent through `session.send`, to a follow-up builder if that subagent has finished, or to the main agent as a prompt. The note text colour shows its state: grey draft, cyan sending, green ran, red failed.
- **Recaps + Learn**: every finished task gets What · How · Learned, written by Haiku. Learn adds "Explain deeper", a daily digest and concept filters.
- **Spotlight (⌘K)**: full-text search across every session's tasks, notes, recaps, activity, questions and digests. Type `>` for commands.
- **Extras**: a radar that flags two agents editing the same file, a questions inbox (`AskUserQuestion` calls and waiting agents), task replay, and an optional export of recaps to Obsidian.
- **Workflows**: draw a graph of steps (builder or scout agents, shell checks, gates that wait for you, an Opus review) on a canvas, save it as versions, and press Run. The hub decides what runs next and queues steps for a live session; nodes light up as they go, a gate waits for Approve (in the Inbox, on the Board card or on the node), and the run's cost ticks live. Cards a run creates carry a run chip, and the Board can group them by run. `CONTRACT.md` v0.9 has the step contract.
- **Model routing**: the session runs on Opus. `helm:builder` uses Sonnet and `helm:scout` uses Haiku, and Opus subagents are downgraded to Sonnet.

## How it fits together

```
Claude Code sessions ──(mod: hooks/register.ts)──▶ helmd (hub/, SQLite event log, unix socket)
                                                     │
                                         http://localhost:7777  (web/, live over SSE)
```

`CONTRACT.md` is the source of truth for every event, row and endpoint.

## Install

Requires Node ≥ 24 (the hub uses `node:sqlite` and has no npm dependencies). At the prompt of a Claude Code terminal session:

```
/plugin install helm --marketplace Alish-Basnett/helm
```

Answer `y` to add the marketplace, then choose the user scope so every session loads it.

To install from a local clone instead:

```bash
claude plugin marketplace add /path/to/helm
```

```bash
claude plugin install helm@helm-local --scope user
```

New sessions load Helm automatically and start the hub on first use. Open the dashboard with `/helm`, or go to http://localhost:7777. Optional settings, which you can change with `/plugin configure helm@helm-local` in a terminal session:

- `obsidianExport` (default off)
- `obsidianPath`

## Develop

```bash
node --test hub/test/
```

```bash
claude plugin test ~/WebDev/builtbyAlish/helm
```

- Hub: `node hub/helmd.mjs --detach | --stop | --status | --rebuild`, `--seed --demo-live --port 7798` for demo data.
- Data: `~/.helm/` (`helm.db`, `helmd.sock`, `helmd.log`).
- Use a `claude` build of at least 2.1.29x for `plugin validate` and `plugin test`. Older builds reject `prompt.compose`.
