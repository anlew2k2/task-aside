# Sequence: Telegram Pairing, Control & Notifications

Covers one-time pairing (`task-aside auth telegram`), single-owner long polling, Draft Cards, slash commands, callbacks, Swipe-Reply resume, and serialized live notifications.

## 1. One-Time Pairing (`auth telegram`)

```mermaid
sequenceDiagram
  autonumber
  participant O as "Owner (Telegram DM)"
  participant CLI as "CLI (auth telegram)"
  participant API as Telegram Bot API
  participant CFG as settings.json

  CLI->>CFG: Read telegram.bot_token (fail if unset)
  CLI->>API: getMe & flush stale getUpdates (409 fails fast)
  CLI-->>O: Print bot URL & 5-minute /auth token
  loop Poll getUpdates until TTL
    O->>API: Private DM /auth token
    API-->>CLI: Constant-time token match & private chat check
  end
  CLI->>API: Ack offset, setMyCommands & send confirmation DM
  CLI->>CFG: Persist user_id, chat_id & transports.telegram = true
```

## 2. Draft Card Intake (Plain Text)

```mermaid
sequenceDiagram
  autonumber
  participant O as "Owner (Telegram DM)"
  participant TG as Telegram Transport
  participant H as "Task Handler"

  O->>TG: Send plain text DM (unauthorized user/chat ignored)
  TG->>TG: Cache in-memory draft (max 100)
  TG-->>O: Send Draft Card (Run, Discard, Agent, Priority)
  O->>TG: Optionally toggle Agent/Priority, then tap Run or Discard
  TG->>H: On Run -> createTask & edit card to queued
```

## 3. Commands & Swipe-Reply

```mermaid
sequenceDiagram
  autonumber
  participant O as "Owner (Telegram DM)"
  participant TG as Telegram Transport
  participant H as "Handlers (task / health)"

  alt Slash command or card button
    O->>TG: Send /run, /list, /task, /cancel, /retry, /use, or /health
    TG->>H: Route command/callback & update view or filters
  else Swipe-reply to task card or .md caption
    O->>TG: Reply with follow-up prompt
    TG->>H: Extract UUID v7, call getTask & createTask (parent_id + session_id)
  end
```

## 4. Live Notifications & Delivery

```mermaid
sequenceDiagram
  autonumber
  participant U as "Task Usecase"
  participant TG as Telegram Transport
  participant O as "Owner (Telegram DM)"

  U-->>TG: Emit task.started
  TG-->>O: Silently edit tracked card to running (or post silent card)
  U-->>TG: Emit task.finished / task.cancelled
  TG-->>O: Edit card to terminal status (Retry / Refresh)
  alt Output <= 3200 chars
    TG-->>O: Push message with inline output
  else Output > 3200 chars
    TG-->>O: Push 1500-char excerpt + silent .md file (UUID in caption)
  end
```

## Telegram Rules & Boundaries

| Aspect | Behavior |
| --- | --- |
| **Pairing & auth** | Single-owner private DM bound to `user_id` + `chat_id`; non-matching updates ignored; `bot_token` redacted in logs/errors |
| **Slash commands** | `/run`, `/list [status]`, `/task <id>`, `/cancel <id>`, `/retry <id>`, `/use`, `/health`, `/help` (and `/start`) |
| **Inline callbacks** | Draft (`Run`, `Discard`, `Agent`, `Priority`), Defaults (`/use`), List filters, Task (`Cancel`/`Retry`, `Refresh`) |
| **Result delivery** | Per-task notifications serialize in memory; short output renders inline, long output sends excerpt + `.md` attachment |
| **Zero core state** | Drafts (max 100), card map (max 500), defaults, per-task queues, and poll offset live in memory only |
