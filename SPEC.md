# dsh-adrian-agents-group-work — Plugin Specification (v2)

Status: draft for owner review.
Supersedes: `agents-committee/SPEC.md` (v1).
Target platform: DeepSeek Harness (dsh) 0.1.2-rc.1, Web profile.
Form: standalone DSH plugin. No dependency on any other plugin.

Reference model: Claude Code agent teams, enabled by
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
Sources: [agent teams docs](https://code.claude.com/docs/en/agent-teams),
[agent communication analysis](https://github.com/cablate/claude-code-research/blob/2c5df191f5667ac1188766a18264e54ce2f028b5/source-code-analysis/phase-03-agent-architecture/07-agent-communication.md).

---

## 1. What the plugin does

The plugin turns one chat session into a group-work room.

The room holds several sub-agents. The sub-agents message each other, share a
task list, and work one job. The main agent is the chair. It opens the room,
watches it, and reports to the owner.

Two entry paths, and either one works:

**Plain language.** The owner writes an ordinary message, as in Claude Code.

```
Spawn 3 agents to build the site. One builder, one critic.
```

**The slash command.** The owner types the command for an explicit start.

```
/agents-group-work Spawn 2 agents to build the site. One builder, one critic.
/agents-group-work Spawn 3 agents to discuss the pricing question until consensus.
```

Both paths reach the same room. The plugin holds no end policy. The brief, in
either form, carries the job and the stop condition.

### 1.1 What we copy from Claude Code

| Claude Code part | Our copy |
|---|---|
| Plain-language start, no setup step | The main path. A prompt section teaches the chair the capability, and the chair opens the room on its own |
| No confirmation before spawn | The chair opens a room without asking |
| Team lead | The chair, which is the main session agent |
| Teammates | Members, which are continuable children |
| `~/.claude/teams/<team>/config.json` roster | `~/.dsh/agents-group-work/rooms/<roomId>/config.json` |
| `inboxes/<name>.json` mailbox | `inboxes/<name>.json`, same name |
| `~/.claude/tasks/<team>/` task list | `~/.dsh/agents-group-work/tasks/<roomId>/` |
| `SendMessage` with `to: <name> \| "*"` | `room_send` with the same `to` grammar |
| `TaskCreate`, `TaskList`, `TaskUpdate` | `room_task_create`, `room_task_list`, `room_task_update` |
| The rule that plain text is invisible | Rule 1 in section 6, in every member prompt |
| Automatic delivery, no inbox polling | The plugin delivers. A member never polls |
| Idle notice with the final answer | A settled notice to the chair |
| A progress line every 30s | A line built from the member's own last tool call. No model call, no session |
| Plan approval and shutdown messages | The same two JSON message shapes |
| User opens any member's transcript | The built-in subagent catalog, no new UI |

### 1.2 What we cannot copy

| Claude Code part | Why not |
|---|---|
| A teammate messages a sibling directly | DSH delivers only between a parent and its direct child. The plugin carries the mail and wakes the receiver through the chair |
| A teammate spawned into read-only plan mode | Plan mode is per-agent, the web profile disables the host-plane copy, and each agent preset keeps a private instance. A standalone plugin cannot reach it |
| Split terminal panes | DSH is a web GUI. The subagent catalog replaces the panel |
| Team folder deleted at session exit | We archive the room instead, so the record survives |
| A fork that leaves no transcript | Claude Code's summary fork passes `skipTranscript: true`. The DSH fork provider offers no such option, so this plugin builds the progress line without a fork. See section 7.1 |

---

## 2. How a room starts

The main path is plain language, exactly as in Claude Code. The owner writes an
ordinary message:

```
Spawn 3 agents to build the site. One builder, one critic.
```

The plugin registers a short prompt section, so the chair always knows the
capability exists and knows when to open a room. The chair then does the work
itself. There is no setup step, no mode to switch on, and no confirmation.

The slash command `agents-group-work` is the second first-class entry. An owner
who wants an explicit start types the command. The rest of the line is the
brief. The command log keeps it visible in chat. The handler injects the brief
as a chair instruction and returns. It does not spawn a member and it does not
wait.

The brief, spoken or typed, may carry:

- the job, which is required.
- the member count. The owner specifies it. When absent, the chair decides, with
  3 to 5 as its guide. No clamp. Above 6, the chair warns once about token cost,
  then obeys.
- the member names. The owner may specify them. When absent, the chair names
  each member from the job, for example `builder` and `critic`.
- a model or an effort level for a member, for example "use Sonnet for the
  critic". When absent, every member inherits the chair's model and effort.
- the stop condition, for example "until consensus", "until the critic has 0
  issues", or "until a majority vote". The stop condition is free text.
- an output path, for example "write the result to ./decisions/gold.md".

The plugin holds no end policy. The chair reads the stop condition and enforces
it.

### 2.1 What the chair asks

- The chair never asks for permission to open a room. It opens one.
- The chair asks a question only when the job itself is unclear, and only when
  the answer changes the work.
- At most one question per room.
- The chair never asks for a member count, a member name, a model, or a stop
  condition. It decides, and it states what it decided in the room summary.

---

## 3. Roles

### 3.1 The chair

The chair is the main session agent. It does all of this:

1. Reads the brief and derives the job, the members, and the stop condition.
2. Calls `room_open` with the job, the stop condition, and the member list.
3. Watches the room through pushed notifications.
4. Posts a short update to the owner when something matters.
5. Nudges a silent member, then replaces it.
6. Judges the stop condition. Then calls `room_close`.
7. Posts the closing report.

The chair does not relay every message. It reads a digest and decides.

### 3.2 The members

A member is a continuable child with its own context window. It gets:

- a per-child persona, composed by the plugin from the room rules, the job, the
  stop condition, its own role, and the roster.
- a per-child label, so the subagent catalog shows its name.
- its own session, so the owner can open its transcript.
- the chair's model and effort, or an override that the brief names.

Every member gets the same five tools: `room_send`, `room_members`,
`room_task_create`, `room_task_list`, `room_task_update`.

---

## 4. Lifecycle

1. `open` — the chair calls `room_open`. The plugin writes the roster and spawns
   each member.
2. `brief` — each member receives the job, the stop condition, the roster, and
   the room rules in its first prompt.
3. `work` — members message each other and claim tasks. The plugin delivers.
4. `settle` — the chair decides the stop condition holds. It calls `room_close`.
5. `report` — the chair posts one status line and the result. For example
   `website-build DONE`, then the outcome.
6. `adjourn` — the plugin sends a shutdown request to each member, releases
   them, and moves the room to `archive/`.

There is no round limit and no wall-clock cap. The room runs until the stop
condition holds, or until the owner says to stop.

---

## 5. Tools

### 5.1 Chair tools

| Tool | Purpose |
|---|---|
| `room_open` | Write the roster and spawn the members |
| `room_send` | Message one member, or broadcast with `to: "*"` |
| `room_members` | Read the roster and each member's status |
| `room_task_create`, `room_task_list`, `room_task_update` | The shared task list |
| `room_pause` | Hold delivery of new work to members |
| `room_resume` | Release held work |
| `room_close` | Shut the members down and archive the room |

`room_open` takes:

```
{
  name: string,            // room label, for example "website-build"
  goal: string,            // the job, in the owner's words
  stopWhen: string,        // the stop condition, in the owner's words
  members: [{ name: string, role: string, instructions?: string }]
}
```

The plugin rejects a duplicate or invalid member name before it spawns anything.

### 5.2 Member tools

The same list, minus the four chair-only tools `room_open`, `room_pause`,
`room_resume`, and `room_close`.

### 5.3 Message grammar

`room_send` takes `{ to, message }`.

| `to` | Meaning |
|---|---|
| `"<name>"` | One member |
| `"*"` | Every other member, one mailbox line each |
| `"chair"` | The chair |

`room_send` also carries the two protocol messages. The shape is Claude Code's.

```json
// member to chair
{"type": "plan_approval_request", "request_id": "a1", "plan": "..."}
// chair to member
{"type": "plan_approval_response", "request_id": "a1", "approve": true}

// chair to member
{"type": "shutdown_request", "request_id": "s1"}
// member to chair
{"type": "shutdown_response", "request_id": "s1", "approve": true}
```

The plugin records each protocol message and answers a plan approval request
with `approve: true` automatically, exactly as the Claude Code harness does.
The real gate on a write stays the sandbox and the approval prompts.

---

## 6. Room rules, injected into every member prompt

1. Plain chat text is invisible to other members. To say anything to the room,
   call `room_send`. A message that was never sent does not exist.
2. `room_send` takes `to: "<member>"`, `to: "*"`, or `to: "chair"`. A broadcast
   costs one line per member. Use it when everyone needs the message.
3. Delivery is turn-based. A message wakes the receiver for its next turn. A
   member does not poll an inbox.
4. The chair is the only mid-turn receiver.
5. `room_members` lists who is in the room. Read it before the first message.
6. The shared task list holds the work. Claim a task before you start it, and
   mark it complete when you finish.
7. The stop condition is written in the first prompt. Work toward it. Do not
   declare it met. The chair decides.

---

## 7. What the chair receives

The plugin pushes four kinds of notification. The chair stays idle between them.

| Notification | When |
|---|---|
| Direct message | A member sent `to: "chair"` |
| Settled notice | A member went idle. The notice carries its final answer |
| Failure notice | A member's model request failed. It names the member and the provider message, and wakes the chair on the third failure inside ten minutes (0.1.4) |
| Progress line | Every 30 seconds, per member. The line names that member's last completed tool call |
| Milestone | A task was claimed or completed, and a member joined or left |

The progress line reads the last completed tool call of that member, as in
`bear: web_search`. The plugin records every completed call through the platform
`tools/result` event, so a line costs no model call and creates no session. A line
that reports a long idle time, as in `bull: bash, idle 124s`, tells the chair that
the member may be stuck. The interval is configurable and the feature can be
switched off.

### 7.1 A finding from the first live run

Version 0.1.0 built this line from a forked summarizer turn, because Claude Code
does. Claude Code's fork passes `skipTranscript: true`, so its forks leave no
trace. The DSH fork provider offers no such option, so every fork became a real
session: one new catalog row, one log on disk, and one model call per busy member
per tick. A five-minute run created 27 such sessions and 1.3 MB of logs, and the
lines were useless, for example "I write one short line now."

Version 0.1.1 removes the fork. The lesson is general: a copy of another product's
mechanism must be re-proved on this platform, because one hidden option can carry
most of the cost.

---

## 8. State on disk

```
~/.dsh/agents-group-work/
├── rooms/<roomId>/
│   ├── config.json           # roster: name, agent id, session id, status
│   └── inboxes/<name>.json   # one mailbox per member. One entry per message
├── tasks/<roomId>/           # the shared task list
└── archive/<roomId>/         # a closed room, moved here whole
```

- `roomId` is `session-<first 8 characters of the session id>`, as in Claude
  Code. The room label from `room_open` is a field inside `config.json`.
- The path root comes from `dshHomePath("agents-group-work")`, so a configured
  `$DSH_HOME` moves it.
- Every write is atomic. One in-process lock per room serializes mutations.
- A member name is sanitized to one path segment. A colliding name is rejected
  at `room_open`, before any spawn.
- A protocol message is recorded as sent only after its mailbox write succeeds,
  as in Claude Code.
- Disk is the truth. Every reader reads files, never memory.

---

## 9. Edge cases

| Case | Behavior |
|---|---|
| Duplicate or invalid member name | Rejected at `room_open`, before any spawn |
| A member is silent after a wake | The chair nudges once. A second silence replaces the member |
| A member's model request fails | The chair receives a notice with the member name and the provider message. Three failures inside ten minutes wake the chair (0.1.4) |
| A replaced member | A new member with a new session. The old member's entries stay in the transcript, marked `void`. The transcript is never rewritten |
| The owner says to pause | The chair calls `room_pause`. Delivery stops, members finish the current turn, the room stays open |
| The owner says to continue | The chair calls `room_resume`. Held mail is delivered |
| A vote is never requested | The chair calls one when the owner asks to end early |
| The owner names a file to write | The chair writes it with ordinary file tools. The plugin holds no minutes feature |
| A mailbox write fails | The sender is told the message was not sent. Nothing is recorded as sent |
| The session ends with a room open | The room is archived as `halted` |

---

## 10. Platform limits to state plainly

1. **Members cannot message each other directly.** DSH delivers only between a
   parent and its direct child. The plugin carries the mail, and wakes the
   receiver through the chair. The body is wrapped as `[builder] ...` so the
   sender stays clear.
2. **The chair is the sender of record for every wake.** A member's transcript
   shows the chair as the sender, with the true sender inside the body.
3. **No read-only plan phase.** Planning is a room rule, not a lock.
4. **No HTTP route.** The room state is JSON on disk. Nothing in the GUI reads
   it. The built-in subagent catalog is the only view.
5. **A concurrency check is required before the build is accepted.** A member's
   turn must run while the chair is idle, and while the chair is inside another
   tool call. If it does not, the design fails and we stop.

---

## 11. Acceptance tests

1. `/agents-group-work` with 3 named members spawns exactly 3 members. The
   roster in `config.json` lists all 3.
2. A work run produces inter-member traffic in `inboxes/*.json`. At least one
   entry has `to: "*"`.
3. Every entry in the transcript came from `room_send`. Proof by construction:
   the mailboxes are the only transcript and only `room_send` writes them. A
   member that claims a message with no matching mailbox entry is flagged.
4. A discussion run with the stop condition "until consensus" ends with all
   members agreeing on one written outcome, and the agreement is recorded.
5. A run that the owner ends early with "until a majority vote" records the
   split honestly. The chair never reports a majority as consensus.
6. The chair posts one status line and the result at close. With no output path
   in the brief, no file is written. With a path, the file exists.
7. Message totals read from `config.json` and the mailboxes match a count of the
   mailbox entries.
8. `room_pause` then `room_resume` preserves the transcript and the task list.
9. A fresh profile installs the package from GitHub, and passes tests 1 to 8.

---

## 12. Non-goals for v1

- No HTTP route and no GUI panel. The subagent catalog is the view.
- No quality-gate hooks. Claude Code offers `TeammateIdle`, `TaskCreated`, and
  `TaskCompleted`. This plugin offers none in v1.
- No dependency edges between tasks.
- No forced vote. The stop condition is free text and the chair judges it.
- No minutes feature.
- No wall-clock cap and no round limit.
- No cross-workspace room. One room per chair session, as in Claude Code.
- No nested rooms. A member cannot open its own room.

---

## 13. Open items

1. The concurrency check in section 10, item 5. **Settled:** proven in the first
   live run. A child ran at 0 s, 19.5 s, and 39.5 s inside the parent's 60-second
   tool call.
2. Whether the forked progress turn shares the member's prompt cache in DSH.
   **Settled:** it does not matter. Version 0.1.1 removed the fork. See section 7.1.
3. The exact wording of the chair instruction injected by the command handler.
4. Whether the plugin needs the agent-plane patch in addition to the host-plane
   patch, or the host plane alone. **Settled:** the host plane alone. A clean
   install from GitHub boots and runs.
