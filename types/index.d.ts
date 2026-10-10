// State contract for the Helm mod's in-session UI (hooks/ui.tsx).
// The snapshot is refreshed from the hub every 5 s and read by the band and the pane.

/** The slice of a hub Task (see CONTRACT.md) the band and the pane need. */
export type HelmTask = {
  id: string
  title: string
  status: 'backlog' | 'next' | 'in_progress' | 'review' | 'done' | 'later' | 'blocked' | 'archived'
}

/** This session's agents counted by hub status (running, done, failed, stalled, waiting). */
export type HelmAgentCounts = Record<string, number>

declare module 'claude-code' {
  interface PluginState {
    helm: {
      /** This session's tasks, as the hub lists them. */
      tasks: HelmTask[]
      /** This session's agents by status. */
      agents: HelmAgentCounts
      /** Open questions that wait on the person, for this session (0 when the hub has no /v1/questions yet). */
      questions: number
      /** The hub answered the last refresh. */
      hubUp: boolean
    }
  }
}
