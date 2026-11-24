# Sequence: Telegram Pairing, Control & Notifications

Covers one-time interactive pairing (`task-aside auth telegram`), single-owner long polling, Draft Cards, slash commands, inline callbacks, Swipe-Reply resume, and serialized live notifications.

## Pairing Flow

```mermaid
sequenceDiagram
  autonumber
  participant O as "Owner (Telegram DM)"
  participant CLI as "CLI (auth telegram)"
  participant API as Telegram Bot API
  participant CFG as settings.json

  CLI->>CFG: Read telegram.bot_token (fail if unset)
  CLI->>API: getMe & flush stale getUpdates (409 fails fast)
  CLI-->>O: Print bot URL and 5-minute /auth token
  loop Poll getUpdates (message only) until TTL
    O->>API: Private DM /auth token
    API-->>CLI: Update payload
    CLI->>CLI: Constant-time token match & private chat check
  end
  CLI->>API: Ack offset, setMyCommands & send confirmation DM
  CLI->>CFG: Persist user_id, chat_id & transports.telegram = true
```

## Runtime Intake, Control & Delivery

```mermaid
sequenceDiagram
  autonumber
  participant O as "Owner (Telegram DM)"
  participant API as Telegram Bot API
  participant TG as Telegram Transport
  participant H as "Handlers (task / health)"
  participant U as "Task Usecase (Events)"

  TG->>U: Subscribe to task.started, task.finished & task.cancelled
  loop Long-poll getUpdates (message, callback_query)
    O->>API: DM text, command, swipe-reply, or button tap
    API-->>TG: Deliver updates (error backoff + token redaction)
    alt Unauthorized user_id or chat_id
      TG->>TG: Ignore update silently
    else Plain text (Draft Card)
      TG->>TG: Cache in-memory draft (max 100)
      TG->>API: Send Draft Card (Run, Discard, Agent, Priority)
      O->>API: Tap Agent/Priority, Discard, or Run
      TG->>H: On Run -> createTask & morph card to queued
    else Slash command or card button
      TG->>H: Route /run, /list, /task, /cancel, /retry, /health
      Note over TG,H: /use & list filters update in-memory view or re-query listTasks
    else Swipe-reply to task card or .md caption
      TG->>TG: Extract UUID v7 from replied text or caption
      TG->>H: getTask -> createTask with parent_id & session_id
    end
  end

  par Serialized Lifecycle Notifications (per-task queue)
    U-->>TG: Emit task.started
    TG->>API: Edit tracked card to running (or send silent card)
  and Terminal Delivery
    U-->>TG: Emit task.finished / task.cancelled
    TG->>API: Best-effort card edit to terminal status (Retry / Refresh)
    alt Output <= 3200 chars (fits 4096-char limit)
      TG->>API: Push message with inline output
    else Output > 3200 chars
      TG->>API: Push 1500-char excerpt + silent .md file with task UUID caption
    end
  end
```

## Telegram Rules & Boundaries

| Aspect | Behavior |
| --- | --- |
| **Pairing & auth** | Single-owner private DM bound to both `user_id` and `chat_id`; non-matching updates ignored; `bot_token` redacted in logs/errors |
| **Slash commands** | `/run`, `/list [status]`, `/task <id>`, `/cancel <id>`, `/retry <id>`, `/use`, `/health`, `/help` (and `/start`) |
| **Inline callbacks** | Draft (`Run`, `Discard`, `Agent`, `Priority`), Defaults (`/use`), List filters (`All`/`Queued`/`Running`/`Completed`/`Failed`), Task (`Cancel`/`Retry`, `Refresh`) |
| **Result delivery** | Short output renders inline; long output splits into push excerpt plus silent `.md` attachment carrying task UUID in caption |
| **Zero core state** | Drafts (max 100), task-card map (max 500), active defaults, per-task queues, and poll offset stay in memory; `public.tasks` stores no Telegram state |
