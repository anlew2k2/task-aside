# Sequence: Worker Execution

Covers the sequential background loop from claiming a queued task in Supabase through running a headless CLI agent and persisting the standardized result.

## Claim, Heartbeat & Execution Flow

```mermaid
sequenceDiagram
  autonumber
  participant W as Worker Transport
  participant U as Task Usecase
  participant DB as "Supabase RPC & Table"
  participant A as Agent Service
  participant CLI as "Headless CLI (agy/claude/codex)"
  participant FS as "~/.task-aside/runs/"

  W->>U: processNextTask(signal)
  U->>DB: RPC claim_next_task(allowed_agents, worker_id, lease_seconds)
  alt Queue empty for allowed_agents
    DB-->>U: null
    U-->>W: processed = false (sleep until next poll)
  else Task claimed (status = running, attempts + 1)
    DB-->>U: Claimed task row
    par Lease Heartbeat
      loop Every heartbeat_interval_ms
        U->>DB: RPC extend_task_lease(task_id, worker_id, lease_seconds)
      end
    and Headless Execution
      U->>A: executeTask(input_envelope, signal)
      A->>A: Enforce allowed_agents, max_permission_mode, allowed_cwd_roots
      A->>FS: Write prompt.md
      A->>CLI: Spawn non-interactive process (no shell interpolation)
      CLI-->>FS: Stream raw output & stderr to agent.log
      CLI-->>A: Exit code + native JSON/JSONL output
      A->>A: Parse native output & wrap into v1 task_result envelope
      A->>FS: Write result.json
      A-->>U: status + result_envelope
    end
    U->>DB: Update status, result_envelope, finished_at (clear lease)
  end
```

## Execution & Output Rules

| Aspect | Behavior |
| --- | --- |
| **Scheduling order** | `claim_next_task` uses `FOR UPDATE SKIP LOCKED`, filtering by `allowed_agents` and ordering by `priority` (`P0` first) then `created_at` |
| **Policy gates** | Pre-spawn checks reject disallowed agents, `permission_mode` above `max_permission_mode`, missing `cwd`, or `cwd` outside `allowed_cwd_roots` |
| **Single-layer wrapping** | Agents run without forced JSON schemas so they produce natural Markdown; `Agent Service` normalizes native CLI output into `task_result` |
| **Local run artifacts** | Each attempt writes `prompt.md`, raw CLI output (`raw-output.json` or `events.jsonl`), `agent.log`, and `result.json` under `~/.task-aside/runs/` |
