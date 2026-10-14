# Onboarding a machine and a session

The steps to get Helm running on a new computer and bring a Claude Code session onto the board.

## 1. Prerequisites

- Node 24 or newer on `PATH`. The hub uses `node:sqlite` and has no npm dependencies.
- Claude Code 2.1.29x or newer: the desktop app's Code tab or the `claude` CLI.
- git, so task diffs work. The project folder should be a git repo.
- Optional: Google Chrome for Studio PDF export and diagram pictures in Word. On macOS, Word export uses the built-in `textutil`.

## 2. Install the plugin (once per machine)

In a terminal:

```bash
claude plugin marketplace add Alish-Basnett/helm
```

```bash
claude plugin install helm@helm-local --scope user
```

Restart any open sessions. In the desktop app, quit with Cmd+Q and reopen. A running session does not pick up a new install, and `/reload-plugins` is not enough.

## 3. Onboard the first session of a project

1. Open a session **in the project folder**, a local session with a folder, not "No folder". Helm makes one project per folder.
2. Send any message. Helm starts the hub on first use. Then check it:
   - `/helm status` shows the hub, project and session.
   - `/helm` or http://localhost:7777 opens the dashboard.
3. In the dashboard the session appears under its project. From now on the session can be driven from Helm: notes, **Start** on a card, and **Talk**.

## 4. Bring another session into the same project

In the second session, run:

```
/helm join <project name>
```

You can also use **Move to project…** on the session in the dashboard. One session belongs to one project until you move it.

## 5. What the onboarded session does on its own

Helm adds an orchestration section to the session's system prompt, so the main (Opus) session follows these rules without being told:

- Before delegating, it creates a card with `mcp__helm__task` (`create`), which returns an id like `T-12`.
- It delegates with the Agent tool. The description starts with `[helm:T-12]`.
  - `helm:builder` (Sonnet) writes code.
  - `helm:scout` (Haiku) reads and searches.
  - Agents run in the background and in parallel when the work is independent.
- When it does a task itself, it calls `work` with the id first, so its tool calls and files land on that card. When it finishes, it calls `update` with status `review`.
- Cards move themselves: In progress, then Review, then a recap (what, how, learned) taken from the builder's DONE/HOW/FILES/LEARNED report.
- Dashboard notes arrive as "Helm note (N-x)". The session answers in 1–2 sentences and the reply shows under the note in Talk. "Start Helm task T-n" means delegate that card now.

## 6. Keep it healthy

- **One copy only.** Use the installed plugin. Don't also load a dev link of the repo in the same session, or two copies run and the older one can swallow replies.
- **Check which copy a session runs:**
  ```bash
  sqlite3 -readonly ~/.helm/helm.db "select json_extract(data,'$.mod') from events where type='session.started' order by id desc limit 3"
  ```
- **Update to the latest commit:** run the two commands below, then quit and reopen the app.
  ```bash
  claude plugin marketplace update helm-local
  ```
  ```bash
  claude plugin update helm@helm-local
  ```
- **Restart the hub:** stop it with the command below. The next session that needs the hub starts it again. Restart every session after an update, so an old session cannot start an old hub.
  ```bash
  node ~/.claude/plugins/cache/helm-local/helm/*/hub/helmd.mjs --stop
  ```
- **Data:** each machine keeps its own board in `~/.helm/`: `helm.db`, `helmd.log` and attachments. Nothing syncs between machines.

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Talk shows "waiting for reply" forever | The session runs an old copy. Update, then quit and reopen the app. |
| `mcp__helm__task` has no `work` or `choices` actions | Same cause: an old copy is loaded. |
| Dashboard won't load | Open `/helm status`. If the hub is down, send any message in a session to start it. Check `~/.helm/helmd.log`. |
| A card shows no diff | The folder isn't a git repo, or it was moved. The card still lists its files. |
| Port 7777 is busy | The hub falls back to another port, written to `~/.helm/helmd.port`. Open that port. `/helm` still shows 7777 for now. |
