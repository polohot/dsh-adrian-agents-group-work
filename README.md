# dsh-adrian-agents-group-work

Group work for the DeepSeek Harness. The plugin turns one chat session into a room.

A room holds a chair and several member agents. The chair is the main session agent.
Each member is a continuable child with its own session. Members send each other
messages and share a task list.

The plugin is standalone. It needs no other plugin.

## What it does

The chair opens a room and names the members. The plugin spawns each member as a
continuable child. Every member gets five room tools. The chair gets the same five
plus four more.

DSH delivers a message only between a parent and its direct child. Two members are
siblings, so the plugin carries the mail for them. The plugin writes the mailbox file
first. Then it wakes the receiver through the chair. The message body carries the true
sender, as in `[builder] hello`.

Disk is the truth. Every reader reads files.

## Requirements

- DeepSeek Harness 0.1.2-rc.1 or later.
- A web profile.
- The host services `tools`, `commands`, `subagents`, `systemPrompt`, `agents`, and
  `sessions`. The plugin declares all six.

## Install

```sh
dsh plugin --profile <profile> add github:<owner>/dsh-adrian-agents-group-work
```

Then restart the profile.

The package declares `dsh.bundle.patch`, so the install adds it to the profile's
bundle list. Confirm the name appears in `bundles` in the profile's `package.json`.

## Remove

One command and one restart:

```sh
dsh plugin --profile <profile> remove dsh-adrian-agents-group-work
```

Then restart the profile. The room records stay on disk. Delete them by hand when you
want them gone:

```sh
rm -rf "${DSH_HOME:-$HOME/.dsh}/agents-group-work"
```

## Use

### Plain language

Write an ordinary message. The plugin adds a short section to the prompt of every root
session, so the chair knows the capability exists.

```
Spawn 3 agents to build the site. One builder, one critic.
```

### The slash command

```
/agents-group-work Spawn 2 agents to build the site. One builder, one critic.
/agents-group-work Spawn 3 agents to discuss the pricing question until consensus.
```

The handler injects the brief as a chair instruction and returns. It does not spawn a
member and it does not wait.

The brief may carry the job, the member count, the member names, a model or an effort
per member, the stop condition, and an output path. The chair decides anything the
brief leaves out. The chair asks at most one question, and only when the job itself is
unclear.

### What the chair does

1. Read the brief. Derive the job, the members, and the stop condition.
2. Call `room_open`.
3. Watch the room.
4. Nudge a silent member.
5. Judge the stop condition.
6. Call `room_close`.
7. Post one status line and the result.

## The tools

### Member tools

Every member gets these five. The chair gets them too.

| Tool | Purpose |
|---|---|
| `room_send` | Send one message. `to` takes `"<member>"`, `"*"`, or `"chair"` |
| `room_members` | Read the roster and each member's status |
| `room_task_create` | Add one task to the shared list |
| `room_task_list` | Read the shared list |
| `room_task_update` | Claim a task or mark it complete |

### Chair tools

The chair gets these four as well.

| Tool | Purpose |
|---|---|
| `room_open` | Write the roster and spawn the members |
| `room_pause` | Hold delivery of new work to members |
| `room_resume` | Release held work |
| `room_close` | Shut the members down and archive the room |
| `room_debug` | Read the room state from disk and check the invariants |

`room_open` and `room_debug` are registered in the scope of each root session.
The other eight are registered when a room opens. No tool goes into the global
registry, so a session that is not a chair never sees a room tool.

A member is a delegated child. It never receives `room_open`, so a room cannot nest.

## Message grammar

`room_send` takes `{ to, message }`.

| `to` | Meaning |
|---|---|
| `"<name>"` | One member |
| `"*"` | Every other member. One mailbox line each |
| `"chair"` | The chair |

A `message` that parses as JSON with a `type` field becomes a protocol message. The
four types are `plan_approval_request`, `plan_approval_response`, `shutdown_request`,
and `shutdown_response`. The shapes match Claude Code.

The plugin answers a plan approval request with `approve: true` automatically. The real
gate on a write stays the sandbox and the approval prompts.

## Room rules

The plugin writes these seven rules into every member prompt.

1. Plain chat text is invisible to other members. Call `room_send`.
2. `room_send` takes a member name, `"*"`, or `"chair"`.
3. Delivery is turn-based. A member does not poll an inbox.
4. The chair is the only mid-turn receiver.
5. Read `room_members` before the first message.
6. Claim a task before you start it.
7. Work toward the stop condition. The chair decides when it holds.

## State on disk

```
${DSH_HOME:-$HOME/.dsh}/agents-group-work/
├── rooms/<roomId>/
│   ├── config.json           # the roster
│   └── inboxes/<name>.json   # one mailbox per member, and one for the chair
├── tasks/<roomId>/           # the shared task list, one file per task
└── archive/<roomId>/         # a closed room, moved here whole
```

- `roomId` is `session-<first 8 characters of the session id>`.
- The room label from `room_open` is a field inside `config.json`.
- The path root comes from `dshHomePath("agents-group-work")`, so a configured
  `$DSH_HOME` moves it.
- Every write goes to a temporary file and then renames. The rename is atomic.
- One in-process lock per room serializes mutations.
- A member name is one safe path segment. The pattern is `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`.
  The name `chair` is reserved. The plugin rejects a duplicate or unsafe name before it
  spawns anything.
- A message counts as sent only after its mailbox write succeeds.
- `config.json` carries `messageTotals`. The plugin updates it on every write, so a
  reader can compare it against a count of the mailbox entries.

A session may hold one live room at a time. After a close, the next room of that
session takes `archive/<roomId>-2`, then `-3`, and so on. An earlier record survives.

## Configuration

The row accepts four optional fields.

| Field | Default | Meaning |
|---|---|---|
| `progressLines` | `true` | Push one short progress line per busy member |
| `progressIntervalMs` | `30000` | The interval between progress passes |
| `shutdownWaitMs` | `20000` | How long `room_close` waits for members to settle |
| `verbose` | `false` | Print every mailbox write, task change, and progress line to the server console |

A progress line names the last completed tool call of that member, as in
`bear: web_search`. The plugin records every completed call in memory, so a line costs no
model call and creates no session. A line that reports a long idle time, as in
`bull: bash, idle 124s`, tells the chair that the member may be stuck. Set
`progressLines: false` to switch the feature off.

The server console stays quiet by default. It prints the boot line, a room opening and
closing, a pause or a resume, and every failure. Set `verbose: true` to add the
per-session arming line, every mailbox write, every task change, and every progress line.

The plugin arms the chair capability in every root session the harness creates, including
sessions restored at startup. That work is silent, because it says nothing a reader needs
and the count is larger than the number of sessions a user has open.

## Platform limits

State these plainly to the user.

1. Members cannot message each other directly. DSH delivers only between a parent and
   its direct child. The plugin carries the mail and wakes the receiver through the
   chair. The body carries the true sender.
2. The chair is the sender of record for every wake of a member. A member's transcript
   shows the chair as the sender, with the true sender inside the body.
3. No read-only plan phase. Planning is a room rule, not a lock.
4. No HTTP route and no GUI panel. The built-in subagent catalog is the view.
5. A member that goes idle leaves the live registry. A message cold-resumes it. The
   plugin rewires its room tools on every creation, so the tools come back.
6. A delegated child runs with the approval policy pinned to `never`. The plugin never
   needs approval, because its tools are plain model tools.

## Verified behavior

The plugin was proven against a live harness. The runs produced these facts.

- 3 named members spawned from one `room_open`. `config.json` listed all three with
  live agent ids. (SPEC test 1)
- Members exchanged messages. `inboxes/*.json` held 8 entries with `to: "*"`, each
  replicated to the mailboxes of the other members. (SPEC test 2)
- Every mailbox entry carried an id, a sender, and a receiver. No malformed entry and
  no duplicate id beyond a broadcast's own replication. (SPEC test 3)
- A room with the stop condition `until consensus` ended with all three members on one
  ordered list, and the record held the proposal, the agreement, and the note.
  (SPEC test 4)
- A room with the stop condition `until a majority vote` ended 2 to 1. The chair
  reported the split and did not call it consensus. (SPEC test 5)
- A brief that named an output path produced that file. A brief that named none
  produced no file. (SPEC test 6)
- `config.json` reported 26 messages and the mailboxes held 26 entries. (SPEC test 7)
- `room_pause` then `room_resume` released exactly one held message, kept every earlier
  entry, and kept all tasks. (SPEC test 8)

Two more checks passed:

- A plugin reload during an open room rebuilt the room from disk. A cold-resumed member
  answered `ROOM TOOLS OK`.
- An unsafe member name and a duplicate member name were both rejected before any
  child was spawned.

## Design notes

- The plugin does not deliver a "settled" notice. DSH sends one to the parent when a
  continuable child settles, so the platform already provides it.
- The plugin holds no end policy. The chair reads the stop condition and judges it.
- The plugin never polls. Delivery is turn-based.

## License

MIT. See `LICENSE`.
