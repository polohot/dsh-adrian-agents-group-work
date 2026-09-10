/**
 * dsh-adrian-agents-group-work — a group-work room for one DSH session.
 *
 * The main session agent is the chair. The chair opens a room and spawns
 * continuable children as members. Members send each other messages, share a
 * task list, and work one job.
 *
 * DSH delivers a message only between a parent and its direct child. Two
 * members are siblings, so the plugin carries the mail for them. The plugin
 * writes the mailbox file first. Then it wakes the receiver through the chair.
 * The body carries the true sender as `[builder] ...`.
 *
 * State lives on disk under `dshHomePath('agents-group-work')`. Disk is the
 * truth. Every reader reads files.
 *
 * @module dsh-adrian-agents-group-work
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Registration id. It must equal the package name. */
export const name = 'dsh-adrian-agents-group-work'

/**
 * Every service this plugin uses. An undeclared access can abort the whole
 * boot.
 */
export const inject = ['tools', 'commands', 'subagents', 'systemPrompt', 'agents', 'sessions']

// ── paths ───────────────────────────────────────────────────────────────────

let resolveHomePath = (...segments) =>
  join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), ...segments)

try {
  const homePaths = await import('@deepseek-ai/dsh-home-paths')
  if (typeof homePaths.dshHomePath === 'function') resolveHomePath = homePaths.dshHomePath
} catch (error) {
  /* The helper is not resolvable from here. The fallback reads $DSH_HOME the
   * same way the harness does, so a configured home still moves the tree. */
}

// ── constants ───────────────────────────────────────────────────────────────

const NS = 'dsh-adrian-agents-group-work'
const CHAIR = 'chair'
const BROADCAST = '*'

/** Tools every member gets. The chair gets these too. */
export const MEMBER_TOOLS = [
  'room_send',
  'room_members',
  'room_task_create',
  'room_task_list',
  'room_task_update',
]

/** Tools only the chair gets. */
export const CHAIR_ONLY_TOOLS = ['room_pause', 'room_resume', 'room_close', 'room_debug']

const PROTOCOL_TYPES = [
  'plan_approval_request',
  'plan_approval_response',
  'shutdown_request',
  'shutdown_response',
]

/** A member name must be one safe path segment. */
const MEMBER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

const DEFAULT_PROGRESS_INTERVAL_MS = 30_000
const DEFAULT_SHUTDOWN_WAIT_MS = 20_000
const WAKE_TIMEOUT_MS = 30_000

/** The room rules from the specification. Every member prompt carries them. */
const ROOM_RULES = [
  '1. Plain chat text is invisible to other members. To say anything to the room, call room_send. A message that was never sent does not exist.',
  '2. room_send takes to: "<member>", to: "*", or to: "chair". A broadcast costs one line per member. Use it when everyone needs the message.',
  '3. Delivery is turn-based. A message wakes the receiver for its next turn. A member does not poll an inbox.',
  '4. The chair is the only mid-turn receiver.',
  '5. room_members lists who is in the room. Read it before the first message.',
  '6. The shared task list holds the work. Claim a task before you start it, and mark it complete when you finish.',
  '7. The stop condition is written in your first prompt. Work toward it. Do not declare it met. The chair decides.',
].join('\n')

/** The chair instruction the prompt section carries. */
const CHAIR_SECTION_TEXT = [
  'You can run group work. A group-work room holds several member agents that message each other and share a task list.',
  'Open a room when the user asks for several agents to work one job together. Examples: "spawn 3 agents to build the site", "discuss this question until consensus".',
  'Call room_open with the job, the stop condition, and the member list. Decide the member count, the names, and the stop condition yourself. Do not ask the user for them.',
  'Do not ask for permission to open a room. Open it. Ask at most one question, and only when the job itself is unclear.',
  'Above 6 members, warn once about token cost. Then obey.',
].join(' ')

// ── small helpers ───────────────────────────────────────────────────────────

/** Write one log line. Every state change calls this. */
/** Print one line always: boot, lifecycle, and failures. */
function log(message) {
  console.log(`[agents-group-work] ${message}`)
}

/** Print one line only when the row sets `verbose: true`. */
function trace(message) {
  if (!verbose) return
  console.log(`[agents-group-work] ${message}`)
}

/** Verbose switch, set from the row config in apply(). */
let verbose = false

/** Build one tool parameter schema root. The root object stays open. */
function params(properties, required) {
  return {
    type: 'object',
    properties,
    ...(required !== undefined && required.length > 0 ? { required } : {}),
  }
}

/** Build one model tool definition. */
function modelTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: params(spec.properties, spec.required),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const missing = (spec.required ?? []).filter((key) => args?.[key] === undefined)
      if (missing.length > 0) {
        throw new Error(`${spec.name}: missing required argument(s) ${missing.join(', ')}`)
      }
      return spec.run(args ?? {}, exec)
    },
  }
}

/** Turn one message into model content. */
function content(text) {
  return [{ type: 'text', text }]
}

/** Build one plugin-authored user message. The shape matches the LLM seam. */
function pluginMessage(text, form) {
  return {
    id: randomUUID(),
    role: 'user',
    content: content(text),
    source: { kind: 'plugin', plugin: NS, form },
  }
}

/** Strip the `session-` prefix of a session id, then take 8 characters. */
export function roomIdOf(sessionId) {
  const text = String(sessionId)
  const bare = text.startsWith('session-') ? text.slice('session-'.length) : text
  return `session-${bare.slice(0, 8)}`
}

/** Validate one member name. An unsafe name returns undefined. */
export function checkMemberName(raw) {
  const text = String(raw ?? '').trim()
  if (!MEMBER_NAME_PATTERN.test(text)) return undefined
  if (text.toLowerCase() === CHAIR) return undefined
  return text
}

/** Escape a persona template. A stray brace pair would break interpolation. */
function safeTemplate(text) {
  return String(text).replace(/\{\{/g, '{ {')
}

/** Wrap one message body so the true sender stays clear. */
function wrap(senderName, text) {
  return `[${senderName}] ${text}`
}

// ── disk ────────────────────────────────────────────────────────────────────

/** One lock per room. The lock serializes every mutation of that room. */
const roomLocks = new Map()

/** Run one task under the room lock. The task runs after the previous one. */
function withRoomLock(roomId, task) {
  const previous = roomLocks.get(roomId) ?? Promise.resolve()
  const next = previous.then(task, task)
  roomLocks.set(
    roomId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** Write one JSON file atomically. A temp file plus rename does the job. */
async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, filePath)
}

/** Read one JSON file. A missing file returns undefined. */
async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** List one directory. A missing directory returns an empty list. */
async function listDir(dirPath) {
  try {
    return await readdir(dirPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

// ── room files ──────────────────────────────────────────────────────────────

function roomsRoot() {
  return resolveHomePath('agents-group-work', 'rooms')
}
function archiveRoot() {
  return resolveHomePath('agents-group-work', 'archive')
}
function roomDir(roomId) {
  return join(roomsRoot(), roomId)
}
function archivedRoomDir(roomId) {
  return join(archiveRoot(), roomId)
}
function configPathIn(dir) {
  return join(dir, 'config.json')
}
function inboxPathIn(dir, memberName) {
  return join(dir, 'inboxes', `${memberName}.json`)
}
function tasksDirIn(dir) {
  return join(dir, 'tasks')
}

/**
 * Pick the archive path of one room. The first room of a session takes
 * `archive/<roomId>`. A later room of the same session takes the next free
 * suffix, so an earlier record survives.
 */
async function freeArchiveDir(roomId) {
  const taken = new Set(await listDir(archiveRoot()))
  if (!taken.has(roomId)) return archivedRoomDir(roomId)
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${roomId}-${index}`
    if (!taken.has(candidate)) return join(archiveRoot(), candidate)
  }
  return join(archiveRoot(), `${roomId}-${Date.now()}`)
}

/** Find the live or archived directory of one room. Disk is the truth. */
async function findRoomDir(roomId) {
  if ((await readJson(configPathIn(roomDir(roomId)))) !== undefined) return roomDir(roomId)
  const archived = (await listDir(archiveRoot()))
    .filter((name) => name === roomId || name.startsWith(`${roomId}-`))
    .sort()
  if (archived.length === 0) return undefined
  const newest = join(archiveRoot(), archived[archived.length - 1])
  if ((await readJson(configPathIn(newest))) === undefined) return undefined
  return newest
}

// ── roster ──────────────────────────────────────────────────────────────────

async function readRoom(dir) {
  return readJson(configPathIn(dir))
}

async function writeRoom(dir, config) {
  await writeJson(configPathIn(dir), config)
}

/** Read one mailbox. A missing mailbox reads as an empty list. */
async function readInbox(dir, memberName) {
  const file = await readJson(inboxPathIn(dir, memberName))
  if (file === undefined) return { member: memberName, entries: [] }
  if (!Array.isArray(file.entries)) file.entries = []
  return file
}

async function writeInbox(dir, memberName, file) {
  await writeJson(inboxPathIn(dir, memberName), file)
}

/** Append one entry to a mailbox. This write is what makes a message sent. */
async function appendInbox(dir, memberName, entry) {
  const file = await readInbox(dir, memberName)
  file.member = memberName
  file.entries.push(entry)
  await writeInbox(dir, memberName, file)
  return file.entries.length
}

/** Update one mailbox entry in place. */
async function updateInboxEntry(dir, memberName, entryId, patch) {
  const file = await readInbox(dir, memberName)
  const entry = file.entries.find((row) => row.id === entryId)
  if (entry === undefined) return false
  Object.assign(entry, patch)
  await writeInbox(dir, memberName, file)
  return true
}

/** Count the entries of named mailboxes. */
async function countMailboxes(dir, names) {
  const totals = {}
  for (const memberName of names) {
    totals[memberName] = (await readInbox(dir, memberName)).entries.length
  }
  return totals
}

/** List every mailbox name present on disk. */
async function listMailboxNames(dir) {
  const files = await listDir(join(dir, 'inboxes'))
  return files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length))
}

/**
 * Recount every mailbox and store the totals in the roster. The plain counts
 * are what let a reader compare `config.json` against the mailboxes.
 */
async function refreshTotals(dir) {
  const room = await readRoom(dir)
  if (room === undefined) return room
  const names = [...(room.members ?? []).map((member) => member.name), CHAIR]
  const totals = await countMailboxes(dir, names)
  room.messageTotals = totals
  room.messages = Object.values(totals).reduce((sum, value) => sum + value, 0)
  await writeRoom(dir, room)
  return room
}

// ── tasks ───────────────────────────────────────────────────────────────────

async function readTasks(dir) {
  const files = (await listDir(tasksDirIn(dir))).filter((file) => file.endsWith('.json'))
  const tasks = []
  for (const file of files) {
    const task = await readJson(join(tasksDirIn(dir), file))
    if (task !== undefined) tasks.push(task)
  }
  tasks.sort((left, right) => String(left.id).localeCompare(String(right.id)))
  return tasks
}

async function readTask(dir, id) {
  return readJson(join(tasksDirIn(dir), `${id}.json`))
}

async function writeTask(dir, task) {
  await writeJson(join(tasksDirIn(dir), `${task.id}.json`), task)
}

// ── the plugin ──────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  verbose = config?.verbose === true

  const settings = {
    progressLines: config?.progressLines !== false,
    progressIntervalMs:
      Number.isFinite(config?.progressIntervalMs) && config.progressIntervalMs > 0
        ? config.progressIntervalMs
        : DEFAULT_PROGRESS_INTERVAL_MS,
    shutdownWaitMs:
      Number.isFinite(config?.shutdownWaitMs) && config.shutdownWaitMs >= 0
        ? config.shutdownWaitMs
        : DEFAULT_SHUTDOWN_WAIT_MS,
  }

  /**
   * Tools registered in one agent scope, grouped by owner. `arm` holds the
   * chair capability, which outlives a room. `room` holds the chair's room
   * tools. `member` holds a member's room tools.
   */
  const registrations = new Map()
  /** Tool names already registered in one group, keyed by scope and group. */
  const registeredNames = new Map()
  /** Agent id to its room and member name. This index is a cache, not the truth. */
  const memberIndex = new Map()
  /** One progress timer per open room. */
  const progressTimers = new Map()
  /**
   * Last completed tool call per agent id. A progress line reads this map, so
   * the line costs no model call and leaves no session behind. The map is a
   * rolling cache: it never grows without bound.
   */
  const lastTool = new Map()

  // ── registration ──────────────────────────────────────────────────────────

  function nameKey(agentId, group) {
    return `${agentId}\u0000${group}`
  }

  /**
   * Register one tool in one agent scope. The plugin owns the disposer, so the
   * registration goes away on plugin unload. A name that is already registered
   * in that group is skipped, because the registry rejects a duplicate.
   */
  function registerIn(agent, definition, label, group) {
    const agentId = String(agent.id)
    const key = nameKey(agentId, group)
    const names = registeredNames.get(key) ?? new Set()
    if (names.has(definition.name)) {
      log(`tool ${definition.name} is already registered for ${agentId} in ${group}. Kept the first one.`)
      return
    }
    names.add(definition.name)
    registeredNames.set(key, names)
    const owned = registrations.get(agentId) ?? []
    owned.push({
      group,
      dispose: ctx.effect(() => agent.ctx.tools.register(definition), `${NS}:${label}`),
    })
    registrations.set(agentId, owned)
  }

  /** Drop every registration of one group in one scope. */
  function disposeGroup(agentId, group) {
    registeredNames.delete(nameKey(agentId, group))
    const owned = registrations.get(agentId)
    if (owned === undefined) return
    const kept = []
    for (const entry of owned) {
      if (entry.group !== group) {
        kept.push(entry)
        continue
      }
      try {
        entry.dispose()
      } catch (error) {
        log(`tool disposer failed for ${agentId} in ${group}: ${error?.message ?? error}`)
      }
    }
    if (kept.length === 0) registrations.delete(agentId)
    else registrations.set(agentId, kept)
  }

  /** Drop every registration in one scope. The agent left the registry. */
  function disposeAll(agentId) {
    for (const group of ['arm', 'room', 'member']) disposeGroup(agentId, group)
    registrations.delete(agentId)
  }

  // ── room lookup ───────────────────────────────────────────────────────────

  /** Resolve the room of one calling agent. Disk is the truth on a cache miss. */
  async function roomOfAgent(agent) {
    const agentId = String(agent.id)
    const cached = memberIndex.get(agentId)
    if (cached !== undefined) {
      const dir = await findRoomDir(cached.roomId)
      if (dir !== undefined) return { roomId: cached.roomId, member: cached.member, dir }
      memberIndex.delete(agentId)
    }
    const bases = [
      [roomsRoot(), await listDir(roomsRoot())],
      /* The newest archive carries the suffix, so read the archive backwards. */
      [archiveRoot(), (await listDir(archiveRoot())).reverse()],
    ]
    for (const [base, names] of bases) {
      for (const name of names) {
        const dir = join(base, name)
        const room = await readRoom(dir)
        if (room === undefined) continue
        const roomId = String(room.roomId ?? name)
        if (String(room.chairSessionId) === agentId) return { roomId, member: CHAIR, dir }
        const row = (room.members ?? []).find((member) => String(member.agentId) === agentId)
        if (row !== undefined) {
          memberIndex.set(agentId, { roomId, member: row.name })
          return { roomId, member: row.name, dir }
        }
      }
    }
    return undefined
  }

  /** Resolve the room and fail loud when the caller is not in one. */
  async function requireRoom(agent) {
    const found = await roomOfAgent(agent)
    if (found === undefined) throw new Error('this agent is not in an open group-work room')
    return found
  }

  function memberNameOf(room, agent) {
    const row = (room.members ?? []).find((member) => String(member.agentId) === String(agent.id))
    return row === undefined ? 'unknown' : row.name
  }

  // ── delivery ──────────────────────────────────────────────────────────────

  /**
   * Wake one target. The route depends on who the target is. `body` is the
   * final text, already wrapped.
   *
   * A member is woken by the chair, because DSH delivers only between a parent
   * and its direct child. The chair is the sender of record for that wake. A
   * member wakes the chair as itself, which DSH allows.
   */
  async function wakeFor(room, from, target, body) {
    const signal = AbortSignal.timeout(WAKE_TIMEOUT_MS)
    if (target === CHAIR) {
      const senderId = activeAgentId(room, from)
      if (senderId === undefined) throw new Error(`sender "${from}" is not a member of this room`)
      const senderAgent = ctx.agents.get(String(senderId))
      if (senderAgent === undefined) throw new Error(`sender "${from}" is not live`)
      await ctx.subagents.sendMessage(senderAgent, room.chairSessionId, content(body), { signal })
      return
    }
    const chairAgent = ctx.agents.get(String(room.chairSessionId))
    if (chairAgent === undefined) throw new Error('the chair session is not live')
    const row = (room.members ?? []).find((member) => member.name === target)
    if (row === undefined) throw new Error(`no member "${target}" in this room`)
    if (row.agentId === null || row.agentId === undefined) {
      throw new Error(`member "${target}" has no agent id yet`)
    }
    await ctx.subagents.sendMessage(chairAgent, String(row.agentId), content(body), { signal })
  }

  function activeAgentId(room, memberName) {
    if (memberName === CHAIR) return room.chairSessionId
    const row = (room.members ?? []).find((member) => member.name === memberName)
    if (row === undefined || row.agentId === null || row.agentId === undefined) return undefined
    return row.agentId
  }

  /**
   * Deliver one message. The mailbox write comes first. A message counts as
   * sent only after that write succeeds.
   */
  async function deliver({ roomId, dir, room, from, to, type, text, requestId }) {
    const entry = {
      id: `m-${randomUUID().slice(0, 8)}`,
      from,
      to,
      type,
      text,
      ...(requestId === undefined ? {} : { requestId }),
      at: new Date().toISOString(),
      held: false,
      delivered: false,
    }

    const targets =
      to === BROADCAST
        ? (room.members ?? []).map((member) => member.name).filter((name) => name !== from)
        : [to]
    if (targets.length === 0) throw new Error('the room has no member to receive this message')

    const paused = room.status === 'paused' && to !== CHAIR
    entry.held = paused

    await withRoomLock(roomId, async () => {
      for (const target of targets) await appendInbox(dir, target, { ...entry, to })
      await refreshTotals(dir)
    })
    trace(`mailbox write ok: ${from} -> ${to} (${type}) held=${paused}`)

    if (paused) return { sent: true, delivered: false, held: true, entry, targets, failures: [] }

    const failures = []
    for (const target of targets) {
      try {
        await wakeFor(room, from, target, wrap(from, text))
        await updateInboxEntry(dir, target, entry.id, { delivered: true })
      } catch (error) {
        failures.push(`${target}: ${error?.message ?? error}`)
      }
    }
    if (failures.length > 0) log(`wake failed: ${failures.join(' | ')}`)
    return { sent: true, delivered: failures.length === 0, held: false, entry, targets, failures }
  }

  // ── tool definitions ──────────────────────────────────────────────────────

  /** The five tools every member gets. */
  function memberDefinitions() {
    return [
      modelTool({
        name: 'room_members',
        description:
          'List the roster of the group-work room. Each row carries the member name, role, status, and task count. The live field is true only while the member is resident. An idle member is not resident, and a message wakes it. Read this before the first message.',
        properties: {},
        run: async (_args, exec) => {
          const { dir } = await requireRoom(exec.agent)
          const room = await readRoom(dir)
          const tasks = await readTasks(dir)
          const totals = await countMailboxes(dir, (room.members ?? []).map((m) => m.name))
          return {
            roomId: room.roomId,
            label: room.name,
            status: room.status,
            goal: room.goal,
            stopWhen: room.stopWhen,
            you: String(room.chairSessionId) === String(exec.agent.id)
              ? CHAIR
              : memberNameOf(room, exec.agent),
            members: (room.members ?? []).map((member) => ({
              name: member.name,
              role: member.role,
              status: member.status,
              live: ctx.agents.get(String(member.agentId)) !== undefined,
              tasks: tasks.filter((task) => task.owner === member.name).length,
              messages: totals[member.name] ?? 0,
            })),
            tasks: tasks.length,
          }
        },
      }),
      modelTool({
        name: 'room_send',
        description:
          'Send a message inside the group-work room. to takes "<member>", "*" for every other member, or "chair". Delivery is turn-based, so the receiver wakes on its next turn. The mailbox write happens first, so a reported send really happened.',
        properties: {
          to: {
            type: 'string',
            description: 'One member name, "*" for all other members, or "chair".',
          },
          message: {
            type: 'string',
            description:
              'The message text. A JSON object carrying a "type" field becomes a protocol message.',
          },
        },
        required: ['to', 'message'],
        run: async (args, exec) => sendTool(exec, args),
      }),
      modelTool({
        name: 'room_task_create',
        description: 'Create one task on the shared task list. Claim a task before you start it.',
        properties: {
          subject: { type: 'string', description: 'Short task title.' },
          description: { type: 'string', description: 'What the task must produce.' },
          owner: { type: 'string', description: 'Member name that owns the task. Optional.' },
        },
        required: ['subject'],
        run: async (args, exec) => {
          const { roomId, dir } = await requireRoom(exec.agent)
          return withRoomLock(roomId, async () => {
            const tasks = await readTasks(dir)
            const room = await readRoom(dir)
            const task = {
              id: `t-${String(tasks.length + 1).padStart(3, '0')}`,
              subject: String(args.subject),
              description: args.description === undefined ? '' : String(args.description),
              status: 'pending',
              owner: args.owner === undefined ? null : String(args.owner),
              createdBy: String(room.chairSessionId) === String(exec.agent.id)
                ? CHAIR
                : memberNameOf(room, exec.agent),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
            await writeTask(dir, task)
            await noteMilestone(dir, `task created ${task.id} ${task.subject}`, task.owner)
            trace(`task created ${task.id} in ${dir}`)
            return task
          })
        },
      }),
      modelTool({
        name: 'room_task_list',
        description: 'Read the shared task list of the group-work room.',
        properties: {
          status: {
            type: 'string',
            description: 'Filter by status.',
            enum: ['pending', 'in_progress', 'completed'],
          },
        },
        run: async (args, exec) => {
          const { dir } = await requireRoom(exec.agent)
          const tasks = await readTasks(dir)
          const rows = args.status === undefined ? tasks : tasks.filter((t) => t.status === args.status)
          return { total: tasks.length, shown: rows.length, tasks: rows }
        },
      }),
      modelTool({
        name: 'room_task_update',
        description:
          'Update one task on the shared task list. Use it to claim a task or to mark it complete.',
        properties: {
          id: { type: 'string', description: 'Task id, for example t-001.' },
          status: { type: 'string', description: 'New status.', enum: ['pending', 'in_progress', 'completed'] },
          owner: { type: 'string', description: 'New owner member name.' },
          subject: { type: 'string', description: 'New short title.' },
          description: { type: 'string', description: 'New description.' },
        },
        required: ['id'],
        run: async (args, exec) => {
          const { roomId, dir } = await requireRoom(exec.agent)
          return withRoomLock(roomId, async () => {
            const task = await readTask(dir, String(args.id))
            if (task === undefined) throw new Error(`no task "${args.id}" in room ${roomId}`)
            const before = task.status
            if (args.status !== undefined) task.status = String(args.status)
            if (args.owner !== undefined) task.owner = String(args.owner)
            if (args.subject !== undefined) task.subject = String(args.subject)
            if (args.description !== undefined) task.description = String(args.description)
            task.updatedAt = new Date().toISOString()
            await writeTask(dir, task)
            if (before !== task.status || args.owner !== undefined) {
              await noteMilestone(dir, `task ${task.id} ${before} -> ${task.status}`, task.owner)
            }
            trace(`task updated ${task.id} -> ${task.status} in ${dir}`)
            return task
          })
        },
      }),
    ]
  }

  /** The chair-only tools. */
  function chairOnlyDefinitions(roomId) {
    return [
      modelTool({
        name: 'room_pause',
        description:
          'Hold delivery of new work to members. Members finish the current turn. The room stays open. Mail sent while paused waits until room_resume.',
        properties: {},
        run: async (_args, exec) => {
          const { dir } = await requireRoom(exec.agent)
          return withRoomLock(roomId, async () => {
            const room = await readRoom(dir)
            room.status = 'paused'
            room.pausedAt = new Date().toISOString()
            await writeRoom(dir, room)
            log(`room ${roomId} paused`)
            return { roomId, status: room.status }
          })
        },
      }),
      modelTool({
        name: 'room_resume',
        description: 'Release held work. Every message held during the pause wakes its receiver.',
        properties: {},
        run: async (_args, exec) => {
          const { dir } = await requireRoom(exec.agent)
          const room = await withRoomLock(roomId, async () => {
            const current = await readRoom(dir)
            current.status = 'open'
            current.resumedAt = new Date().toISOString()
            await writeRoom(dir, current)
            return current
          })
          const released = await flushPending(dir, room)
          log(`room ${roomId} resumed, released ${released} held message(s)`)
          return { roomId, status: 'open', released }
        },
      }),
      modelTool({
        name: 'room_close',
        description:
          'End the room. The plugin sends a shutdown request to each member, waits for them to settle, releases them, and moves the room to the archive.',
        properties: { reason: { type: 'string', description: 'Why the room ends. Optional.' } },
        run: async (args, exec) =>
          closeRoom(exec, await requireRoom(exec.agent), {
            reason: args.reason === undefined ? '' : String(args.reason),
          }),
      }),
    ]
  }

  /**
   * Send one message. The chair and a member use the same path, so one code
   * path carries every message.
   */
  async function sendTool(exec, args) {
    const { roomId, dir } = await requireRoom(exec.agent)
    const room = await readRoom(dir)
    const from = String(room.chairSessionId) === String(exec.agent.id)
      ? CHAIR
      : memberNameOf(room, exec.agent)
    const to = String(args.to).trim()

    if (to !== BROADCAST && to !== CHAIR) {
      const row = (room.members ?? []).find((member) => member.name === to)
      if (row === undefined) {
        throw new Error(`no member "${to}" in room ${roomId}. Call room_members for the roster.`)
      }
      if (row.name === from) throw new Error('room_send cannot send a message to the sender')
    }
    if (to === CHAIR && from === CHAIR) throw new Error('the chair cannot send a message to itself')

    const parsed = parseProtocol(args.message)
    const result = await deliver({
      roomId,
      dir,
      room,
      from,
      to,
      type: parsed.type,
      text: parsed.text,
      requestId: parsed.requestId,
    })

    if (parsed.type === 'plan_approval_request') {
      await answerPlanRequest(dir, room, from, parsed)
    }

    return {
      sent: result.sent,
      delivered: result.delivered,
      held: result.held,
      entryId: result.entry.id,
      from,
      to: result.targets,
      type: parsed.type,
      mailbox: result.targets.map((target) => inboxPathIn(dir, target)),
      failures: result.failures,
    }
  }

  /** Read a protocol message out of the tool text. */
  function parseProtocol(raw) {
    const text = String(raw ?? '')
    const trimmed = text.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const value = JSON.parse(trimmed)
        if (typeof value?.type === 'string' && PROTOCOL_TYPES.includes(value.type)) {
          return {
            type: value.type,
            requestId: value.request_id === undefined ? undefined : String(value.request_id),
            text: trimmed,
          }
        }
      } catch (error) {
        /* Prose that starts with a brace is still a plain message. */
      }
    }
    return { type: 'message', requestId: undefined, text }
  }

  /**
   * Answer one plan approval request with approve: true, as the Claude Code
   * harness does. The real gate on a write stays the sandbox and the approval
   * prompts.
   */
  async function answerPlanRequest(dir, room, from, parsed) {
    const requestId = parsed.requestId ?? 'unknown'
    const response = JSON.stringify({
      type: 'plan_approval_response',
      request_id: requestId,
      approve: true,
    })
    const entry = {
      id: `m-${randomUUID().slice(0, 8)}`,
      from: CHAIR,
      to: from,
      type: 'plan_approval_response',
      requestId,
      text: response,
      at: new Date().toISOString(),
      held: false,
      delivered: false,
    }
    await withRoomLock(room.roomId, async () => {
      await appendInbox(dir, from, entry)
      await refreshTotals(dir)
    })
    try {
      await wakeFor(room, CHAIR, from, wrap(CHAIR, response))
      await updateInboxEntry(dir, from, entry.id, { delivered: true })
    } catch (error) {
      log(`plan approval auto-response wake failed: ${error?.message ?? error}`)
    }
    trace(`auto-approved plan request ${requestId} from ${from}`)
  }

  /** Append one milestone to the chair mailbox. A milestone does not wake. */
  async function noteMilestone(dir, text, owner) {
    if (owner === null || owner === undefined) return
    await appendInbox(dir, CHAIR, {
      id: `m-${randomUUID().slice(0, 8)}`,
      from: owner,
      to: CHAIR,
      type: 'milestone',
      text,
      at: new Date().toISOString(),
      held: false,
      delivered: false,
    })
  }

  /**
   * Wake every member that holds a message which never reached it. A message
   * can wait because the room was paused, or because the receiver had no agent
   * yet when the sender wrote it. This runs once when the room finishes
   * opening, and again on resume.
   */
  async function flushPending(dir, room) {
    let released = 0
    for (const memberName of await listMailboxNames(dir)) {
      if (memberName === CHAIR) continue
      const file = await readInbox(dir, memberName)
      const waiting = file.entries.filter((entry) => entry.delivered !== true)
      if (waiting.length === 0) continue
      try {
        const body = waiting.map((entry) => wrap(entry.from, entry.text)).join('\n\n')
        await wakeFor(room, waiting[waiting.length - 1].from, memberName, body)
        for (const entry of waiting) {
          entry.held = false
          entry.delivered = true
        }
        await writeInbox(dir, memberName, file)
        released += waiting.length
        trace(`delivered ${waiting.length} waiting message(s) to ${memberName}`)
      } catch (error) {
        log(`delivery flush for ${memberName} failed: ${error?.message ?? error}`)
      }
    }
    return released
  }

  // ── close and archive ─────────────────────────────────────────────────────

  async function closeRoom(exec, found, options) {
    const { roomId, dir } = found
    const room = await readRoom(dir)

    for (const member of room.members ?? []) {
      if (member.agentId === null || member.agentId === undefined) continue
      const request = JSON.stringify({ type: 'shutdown_request', request_id: `s-${member.name}` })
      try {
        await withRoomLock(roomId, async () => {
          await appendInbox(dir, member.name, {
            id: `m-${randomUUID().slice(0, 8)}`,
            from: CHAIR,
            to: member.name,
            type: 'shutdown_request',
            requestId: `s-${member.name}`,
            text: request,
            at: new Date().toISOString(),
            held: false,
            delivered: false,
          })
          await refreshTotals(dir)
        })
        await wakeFor(room, CHAIR, member.name, wrap(CHAIR, request))
      } catch (error) {
        log(`shutdown request to ${member.name} failed: ${error?.message ?? error}`)
      }
    }

    const live = (room.members ?? [])
      .map((member) => ctx.agents.get(String(member.agentId)))
      .filter((agent) => agent !== undefined)
    if (live.length > 0 && settings.shutdownWaitMs > 0) {
      await Promise.race([
        Promise.all(live.map((agent) => agent.whenIdle().catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, settings.shutdownWaitMs)),
      ])
    }

    const childIds = (room.members ?? [])
      .map((member) => member.agentId)
      .filter((id) => id !== null && id !== undefined)
      .map((id) => String(id))
    if (childIds.length > 0) {
      try {
        await ctx.subagents.drainContinuableChildren(exec.agent, childIds)
      } catch (error) {
        log(`release of members failed: ${error?.message ?? error}`)
      }
    }

    stopProgress(roomId)
    disposeGroup(String(exec.agent.id), 'room')
    for (const member of room.members ?? []) {
      if (member.agentId !== null && member.agentId !== undefined) {
        disposeGroup(String(member.agentId), 'member')
        memberIndex.delete(String(member.agentId))
      }
    }

    const archived = await withRoomLock(roomId, async () => {
      const current = await readRoom(dir)
      current.status = 'closed'
      current.closedAt = new Date().toISOString()
      current.closeReason = options.reason
      /* The room is over, so no member row is active any more. A reader of the
       * archived record must not see a live member inside a closed room. */
      for (const member of current.members ?? []) {
        if (member.status === 'active') member.status = 'released'
      }
      const totals = await countMailboxes(dir, [...(current.members ?? []).map((m) => m.name), CHAIR])
      current.messageTotals = totals
      current.messages = Object.values(totals).reduce((sum, value) => sum + value, 0)
      current.taskTotal = (await readTasks(dir)).length
      await writeRoom(dir, current)
      return moveRoomToArchive(dir, roomId)
    })

    log(`room ${roomId} closed and archived at ${archived}`)
    return {
      roomId,
      status: 'closed',
      archivedAt: archived,
      configPath: configPathIn(archived),
      messageTotals: room.messageTotals ?? null,
    }
  }

  /** Move one room directory into the archive, whole. */
  async function moveRoomToArchive(dir, roomId) {
    const target = await freeArchiveDir(roomId)
    await mkdir(target, { recursive: true })
    await rename(join(dir, 'inboxes'), join(target, 'inboxes'))
    await rename(configPathIn(dir), configPathIn(target))
    const taskDir = tasksDirIn(dir)
    if ((await listDir(taskDir)).length > 0) await rename(taskDir, tasksDirIn(target))
    await rm(dir, { recursive: true, force: true })
    return target
  }

  // ── progress lines ────────────────────────────────────────────────────────

  /**
   * Start the progress timer of one room. Every interval, each busy member gets
   * one short line. The line names that member's own last completed tool call.
   */
  function startProgress(roomId, dir) {
    if (!settings.progressLines) return
    stopProgress(roomId)
    const timer = setInterval(() => {
      runProgress(roomId, dir).catch((error) => {
        log(`progress pass failed: ${error?.message ?? error}`)
      })
    }, settings.progressIntervalMs)
    progressTimers.set(roomId, timer)
    /* The plugin owns the timer, so an unload stops it. */
    ctx.effect(
      () => () => {
        clearInterval(timer)
      },
      `${NS}:progress:${roomId}`,
    )
    trace(`progress lines on for ${roomId}, every ${settings.progressIntervalMs} ms`)
  }

  function stopProgress(roomId) {
    const timer = progressTimers.get(roomId)
    if (timer === undefined) return
    clearInterval(timer)
    progressTimers.delete(roomId)
  }

  async function runProgress(roomId, dir) {
    const room = await readRoom(dir)
    if (room === undefined || room.status !== 'open') return
    for (const member of room.members ?? []) {
      const agent = ctx.agents.get(String(member.agentId))
      if (agent === undefined || agent.status !== 'running') continue
      try {
        const line = progressLine(agent, member)
        await appendInbox(dir, CHAIR, {
          id: `m-${randomUUID().slice(0, 8)}`,
          from: member.name,
          to: CHAIR,
          type: 'progress',
          text: line,
          at: new Date().toISOString(),
          held: false,
          delivered: false,
        })
        trace(`progress ${member.name}: ${line}`)
      } catch (error) {
        log(`progress for ${member.name} failed: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * One short line for a member, built from its own last completed tool call.
   * No model call runs and no session is created, so the line is free. A line
   * that reports a long idle time tells the chair that the member may be stuck.
   */
  function progressLine(memberAgent, member) {
    const seen = lastTool.get(String(memberAgent.id))
    if (seen === undefined) return `${member.name}: no tool call yet`
    const idleSeconds = Math.round((Date.now() - seen.at) / 1000)
    const stale = idleSeconds >= 90 ? `, idle ${idleSeconds}s` : ''
    return `${member.name}: ${seen.name}${stale}`
  }

  // ── debug ─────────────────────────────────────────────────────────────────

  /** Read the room state from disk and check the invariants. */
  async function debugRoom(dir, roomId) {
    const room = await readRoom(dir)
    const names = await listMailboxNames(dir)
    const mailboxes = {}
    let entries = 0
    let protocol = 0
    let broadcasts = 0
    let held = 0
    let pendingMemberDelivery = 0
    for (const memberName of names) {
      const file = await readInbox(dir, memberName)
      mailboxes[memberName] = file.entries.length
      entries += file.entries.length
      protocol += file.entries.filter((e) => PROTOCOL_TYPES.includes(e.type)).length
      broadcasts += file.entries.filter((e) => e.to === BROADCAST).length
      held += file.entries.filter((e) => e.held === true).length
      /* The chair mailbox holds milestones and progress lines. Those never
       * wake anybody, so only a member mailbox can hold real pending work. */
      if (memberName !== CHAIR) {
        pendingMemberDelivery += file.entries.filter((e) => e.delivered !== true).length
      }
    }
    const tasks = await readTasks(dir)
    const declared = room.messageTotals ?? {}
    const declaredTotal = Object.values(declared).reduce((sum, value) => sum + value, 0)
    const configFile = configPathIn(dir)
    const configText = await readFile(configFile, 'utf8')

    return {
      roomId,
      root: resolveHomePath('agents-group-work'),
      roomDir: dir,
      configPath: configFile,
      configLines: configText.split('\n').length,
      status: room.status,
      label: room.name,
      goal: room.goal,
      stopWhen: room.stopWhen,
      chairSessionId: room.chairSessionId,
      members: (room.members ?? []).map((member) => ({
        name: member.name,
        role: member.role,
        status: member.status,
        agentId: member.agentId,
        live: ctx.agents.get(String(member.agentId)) !== undefined,
      })),
      roomsOnDisk: await listDir(roomsRoot()),
      archivedOnDisk: await listDir(archiveRoot()),
      mailboxPaths: names.map((memberName) => inboxPathIn(dir, memberName)),
      mailboxes,
      mailboxEntryCount: entries,
      protocolEntries: protocol,
      broadcastEntries: broadcasts,
      heldEntries: held,
      pendingMemberDelivery,
      declaredMessageTotals: declared,
      declaredTotal,
      totalsMatchMailboxes: declaredTotal === entries,
      taskCount: tasks.length,
      taskIds: tasks.map((task) => `${task.id}:${task.status}`),
      tasksPath: tasksDirIn(dir),
      registrations: {
        chairScopes: [...registrations.keys()].length,
        indexedMembers: memberIndex.size,
        progressTimers: [...progressTimers.keys()],
      },
    }
  }

  // ── chair awareness ───────────────────────────────────────────────────────

  /**
   * Give one root session the chair capability: the `room_open` tool, the
   * `room_debug` tool, and one short prompt section. A member is a delegated
   * child, so it gets none of them. A room therefore cannot nest.
   */
  function armChair(agent) {
    if (agent.session.header.parentSession !== undefined) return
    const agentId = String(agent.id)
    if (registeredNames.get(nameKey(agentId, 'arm'))?.has('room_debug') === true) return

    registerIn(
      agent,
      modelTool({
        name: 'room_open',
        description:
          'Open a group-work room and spawn its member agents. Each member is a continuable child with its own session and its own room tools. The plugin rejects a duplicate or unsafe member name before it spawns anything.',
        properties: {
          name: { type: 'string', description: 'Short room label, for example "website-build".' },
          goal: { type: 'string', description: 'The job, in the words of the user.' },
          stopWhen: { type: 'string', description: 'The stop condition, in the words of the user.' },
          members: {
            type: 'array',
            description: 'The member list. Order is creation order.',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description:
                    'Member name. Letters, digits, underscore, and hyphen only. 1 to 32 characters.',
                },
                role: { type: 'string', description: 'One-line role, for example "builder".' },
                instructions: { type: 'string', description: 'Extra instructions for this member only. Optional.' },
                model: { type: 'string', description: 'Model override for this member. Optional.' },
              },
              required: ['name', 'role'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'goal', 'stopWhen', 'members'],
        run: async (args, exec) => openRoom(exec, args),
      }),
      'chair:room_open',
      'arm',
    )

    registerIn(
      agent,
      modelTool({
        name: 'room_debug',
        description:
          'Read the group-work room state straight from disk and check its invariants. Use it to prove what the room holds. It reports file paths, line counts, mailbox totals, and task totals.',
        properties: {},
        run: async (_args, exec) => {
          const found = await roomOfAgent(exec.agent)
          if (found === undefined) {
            return { root: resolveHomePath('agents-group-work'), room: null, note: 'no room for this session' }
          }
          return debugRoom(found.dir, found.roomId)
        },
      }),
      'chair:room_debug',
      'arm',
    )

    const owned = registrations.get(agentId) ?? []
    owned.push(
      ctx.effect(
        () =>
          agent.ctx.systemPrompt.section({
            name: `${NS}:chair`,
            order: agent.ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
            text: CHAIR_SECTION_TEXT,
          }),
        `${NS}:chair-section`,
      ),
    )
    registrations.set(agentId, owned)
    log(`chair capability armed for session ${agentId}`)
  }

  // ── room_open ─────────────────────────────────────────────────────────────

  async function openRoom(exec, args) {
    const chairAgent = exec.agent
    const chairSessionId = String(chairAgent.id)
    const roomId = roomIdOf(chairSessionId)

    const live = configPathIn(roomDir(roomId))
    if ((await readJson(live)) !== undefined) {
      throw new Error(
        `room ${roomId} is already open at ${roomDir(roomId)}. One live room per chair session. Close it first.`,
      )
    }

    const requested = Array.isArray(args.members) ? args.members : []
    if (requested.length === 0) throw new Error('room_open needs at least one member')

    const seen = new Set()
    const members = []
    for (const raw of requested) {
      const memberName = checkMemberName(raw?.name)
      if (memberName === undefined) {
        throw new Error(
          `invalid member name "${raw?.name}". Use letters, digits, underscore, and hyphen. 1 to 32 characters. The name "chair" is reserved.`,
        )
      }
      const key = memberName.toLowerCase()
      if (seen.has(key)) throw new Error(`duplicate member name "${memberName}"`)
      seen.add(key)
      members.push({
        name: memberName,
        role: String(raw?.role ?? memberName),
        instructions: raw?.instructions === undefined ? '' : String(raw.instructions),
        model: raw?.model === undefined ? undefined : String(raw.model),
        agentId: null,
        sessionId: null,
        status: 'pending',
        joinedAt: null,
        replacedBy: null,
      })
    }

    const dir = roomDir(roomId)
    const label = String(args.name)
    const goal = String(args.goal)
    const stopWhen = String(args.stopWhen)
    const roster = members.map((member) => `${member.name} (${member.role})`).join(', ')

    const config = {
      version: 1,
      roomId,
      name: label,
      goal,
      stopWhen,
      chairSessionId,
      status: 'opening',
      createdAt: new Date().toISOString(),
      closedAt: null,
      members,
      messageTotals: {},
      messages: 0,
    }

    await withRoomLock(roomId, async () => {
      await writeRoom(dir, config)
      await mkdir(join(dir, 'inboxes'), { recursive: true })
      await mkdir(tasksDirIn(dir), { recursive: true })
    })
    log(`room ${roomId} opened at ${dir} with ${members.length} member(s)`)

    /* The chair gets its room tools before any member exists, so a failure
     * here stops the open before a single child is spawned. */
    for (const definition of [...memberDefinitions(), ...chairOnlyDefinitions(roomId)]) {
      registerIn(chairAgent, definition, `chair:${definition.name}`, 'room')
    }
    trace(`registered ${MEMBER_TOOLS.length + CHAIR_ONLY_TOOLS.length} room tools in scope of ${chairSessionId}`)

    /** Write the roster to disk. Every member row becomes readable at once. */
    async function persistRoster(status, spawnFailures) {
      return withRoomLock(roomId, async () => {
        const current = await readRoom(dir)
        current.members = members
        current.status = status
        current.spawnFailures = spawnFailures
        await writeRoom(dir, current)
        return refreshTotals(dir)
      })
    }

    const spawned = []
    const failures = []
    try {
      for (const member of members) {
        const persona = safeTemplate(
          [
            `You are ${member.name}, the ${member.role} in a group-work room on the DeepSeek Harness.`,
            '',
            `Room: ${label}`,
            `Job: ${goal}`,
            `Stop condition: ${stopWhen}`,
            `Roster: ${CHAIR} (chair), ${roster}`,
            '',
            'ROOM RULES',
            ROOM_RULES,
          ].join('\n'),
        )

        /* Reserve the child identity and name it on disk BEFORE the child
         * exists. The creation listener then finds the row and gives the
         * member its tools before the first turn starts. */
        member.agentId = randomUUID()
        member.sessionId = member.agentId
        member.status = 'pending'
        await persistRoster('opening', failures)

        const start = await ctx.subagents.startContinuable({
          provider: 'spawn',
          childId: member.agentId,
          label: `${label}:${member.name}`,
          request: {
            prompt: content(briefFor(member, label, goal, stopWhen, roster, chairSessionId)),
            parent: chairAgent,
            persona,
            ...(member.model === undefined ? {} : { agentOptions: { model: member.model } }),
          },
          signal: exec.signal,
        })

        const childId = String(start.childId)
        member.agentId = childId
        member.sessionId = childId
        member.status = 'active'
        member.joinedAt = new Date().toISOString()
        spawned.push(childId)
        memberIndex.set(childId, { roomId, member: member.name })

        const childAgent = ctx.agents.get(childId)
        if (childAgent !== undefined) {
          for (const definition of memberDefinitions()) {
            registerIn(childAgent, definition, `member:${definition.name}`, 'member')
          }
        } else {
          trace(`member ${member.name} is not resident yet. The creation listener covers it.`)
        }

        /* Persist this row now. A member that starts work must be reachable by
         * the others, and the others read the roster from disk. */
        await persistRoster('opening', failures)
        trace(`spawned member ${member.name} as ${childId}`)
      }
    } catch (error) {
      const message = error?.message ?? String(error)
      failures.push(`room_open: ${message}`)
      log(`room_open stopped early: ${message}`)
    }

    const room = await persistRoster(failures.length > 0 ? 'halted' : 'open', failures)

    if (failures.length === 0) {
      /* Members start at once and may message each other before the last row
       * exists on disk. Deliver whatever waited. */
      const released = await flushPending(dir, room)
      trace(`room ${roomId} open. ${released} waiting message(s) delivered.`)
      startProgress(roomId, dir)
    } else {
      for (const childId of spawned) {
        try {
          await ctx.subagents.drainContinuableChildren(chairAgent, [childId])
        } catch (error) {
          log(`release of ${childId} failed: ${error?.message ?? error}`)
        }
      }
    }

    return {
      roomId,
      roomDir: dir,
      configPath: configPathIn(dir),
      status: room.status,
      label,
      goal,
      stopWhen,
      members: members.map((member) => ({
        name: member.name,
        role: member.role,
        agentId: member.agentId,
        status: member.status,
      })),
      membersSpawned: spawned.length,
      failures,
    }
  }

  /** Build the first prompt of one member. */
  function briefFor(member, label, goal, stopWhen, roster, chairSessionId) {
    return [
      `Room ${label} is open. You are ${member.name}, the ${member.role}.`,
      '',
      `Job: ${goal}`,
      `Stop condition: ${stopWhen}`,
      `Roster: ${CHAIR} (chair), ${roster}`,
      member.instructions.length > 0 ? `Your instructions: ${member.instructions}` : undefined,
      '',
      'Your room tools are room_send, room_members, room_task_create, room_task_list, and room_task_update.',
      'Start now. Call room_members first. Then claim a task, do the work, and send a message when the room needs it.',
      `When you report to the chair, call room_send with to: "${CHAIR}".`,
      '',
      'ROOM RULES',
      ROOM_RULES,
      '',
      `The chair session id is ${chairSessionId}.`,
    ]
      .filter((line) => line !== undefined)
      .join('\n')
  }

  // ── restore ───────────────────────────────────────────────────────────────

  /** Find the room and member name of one agent id, straight from disk. */
  async function indexAgentOnDisk(agentId) {
    for (const roomId of await listDir(roomsRoot())) {
      const dir = roomDir(roomId)
      const room = await readRoom(dir)
      if (room === undefined) continue
      if (room.status !== 'open' && room.status !== 'paused') continue
      const row = (room.members ?? []).find((member) => String(member.agentId) === agentId)
      if (row !== undefined) return { roomId, member: row.name }
    }
    return undefined
  }

  /**
   * Give one member agent its room tools. This runs on every creation, so a
   * cold-resumed member is rewired exactly like a fresh one.
   */
  async function wireMember(agent) {
    const agentId = String(agent.id)
    if (registeredNames.get(nameKey(agentId, 'member'))?.has('room_send') === true) return
    const found = await indexAgentOnDisk(agentId)
    if (found === undefined) return
    memberIndex.set(agentId, found)
    for (const definition of memberDefinitions()) {
      registerIn(agent, definition, `member:${definition.name}`, 'member')
    }
    trace(`member tools wired for ${found.member} of room ${found.roomId}`)
  }

  /**
   * Rebuild every live room from disk. A plugin reload or a process restart
   * unwinds the tool registrations, so a room that is still open must be read
   * back and rewired. Disk is the truth.
   */
  async function restoreOpenRooms() {
    let restored = 0
    for (const roomId of await listDir(roomsRoot())) {
      const dir = roomDir(roomId)
      const room = await readRoom(dir)
      if (room === undefined) continue
      if (room.status !== 'open' && room.status !== 'paused') continue
      for (const member of room.members ?? []) {
        if (member.agentId === null || member.agentId === undefined) continue
        memberIndex.set(String(member.agentId), { roomId, member: member.name })
        const childAgent = ctx.agents.get(String(member.agentId))
        if (childAgent !== undefined) await wireMember(childAgent)
      }
      const chairAgent = ctx.agents.get(String(room.chairSessionId))
      if (chairAgent !== undefined) {
        for (const definition of [...memberDefinitions(), ...chairOnlyDefinitions(roomId)]) {
          registerIn(chairAgent, definition, `chair:${definition.name}`, 'room')
        }
        startProgress(roomId, dir)
      }
      restored += 1
      trace(`restored open room ${roomId} from ${dir}`)
    }
    if (restored > 0) trace(`restored ${restored} open room(s)`)
  }

  // ── slash command ─────────────────────────────────────────────────────────

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'agents-group-work',
        description:
          'Start a group-work room. The rest of the line is the brief, for example: spawn 3 agents to build the site.',
        input: { hint: 'spawn 3 agents to build the site. One builder, one critic.' },
        handler: (invocation) => commandHandler(invocation),
      }),
    `${NS}:command`,
  )

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Record the last completed tool call of every agent. The progress timer reads
   * this map. The event carries the calling agent, so no session lookup and no
   * agent turn is needed to name what a member is doing.
   */
  ctx.on('tools/result', (exec) => {
    const agent = exec?.agent
    if (agent === undefined) return
    lastTool.set(String(agent.id), { name: String(exec.name), at: Date.now() })
    if (lastTool.size <= 500) return
    const cutoff = Date.now() - 3_600_000
    for (const [id, seen] of lastTool) if (seen.at < cutoff) lastTool.delete(id)
  })

  ctx.on('agent/created', ({ agent }) => {
    try {
      armChair(agent)
    } catch (error) {
      log(`armChair failed for ${agent.id}: ${error?.message ?? error}`)
    }
    /* A delegated child may be a room member. A cold-resumed member arrives
     * here too, so this is where its room tools come back. */
    wireMember(agent).catch((error) => {
      log(`member wiring failed for ${agent.id}: ${error?.message ?? error}`)
    })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const agentId = String(agent.id)
    disposeAll(agentId)
    /* A member that goes idle leaves the live registry and cold-resumes on the
     * next message. That is not a departure, so the roster keeps its row. Only
     * the chair ending the session halts the room. */
    const indexed = memberIndex.get(agentId)
    if (indexed === undefined) return
    haltRoom(indexed.roomId, agentId).catch((error) => {
      log(`halt of room ${indexed.roomId} failed: ${error?.message ?? error}`)
    })
  })

  /** Archive a room whose chair vanished. The record survives. */
  async function haltRoom(roomId, goneAgentId) {
    const dir = await findRoomDir(roomId)
    if (dir === undefined) return
    const room = await readRoom(dir)
    if (room === undefined || room.status === 'closed' || room.status === 'halted') return
    if (String(room.chairSessionId) !== goneAgentId) return

    stopProgress(roomId)
    const archived = await withRoomLock(roomId, async () => {
      const current = await readRoom(dir)
      current.status = 'halted'
      current.closedAt = new Date().toISOString()
      current.closeReason = 'the chair session ended with the room open'
      const totals = await countMailboxes(dir, [
        ...(current.members ?? []).map((member) => member.name),
        CHAIR,
      ])
      current.messageTotals = totals
      current.messages = Object.values(totals).reduce((sum, value) => sum + value, 0)
      current.taskTotal = (await readTasks(dir)).length
      await writeRoom(dir, current)
      return moveRoomToArchive(dir, roomId)
    })
    log(`room ${roomId} halted and archived at ${archived}`)
  }

  // Arm every root session that is already live. A reload must not lose them.
  for (const agent of ctx.agents.roots()) {
    try {
      armChair(agent)
    } catch (error) {
      log(`armChair failed for ${agent.id}: ${error?.message ?? error}`)
    }
  }

  // Rebuild from disk. A reload or a process restart must not strand a room.
  restoreOpenRooms().catch((error) => {
    log(`room restore failed: ${error?.message ?? error}`)
  })

  log(`ready. state root: ${resolveHomePath('agents-group-work')}`)
}

/**
 * Handle the slash command. The handler injects the brief as a chair
 * instruction and returns. It does not spawn a member and it does not wait.
 */
function commandHandler(invocation) {
  const brief = String(invocation.rawInput ?? '').trim()
  if (brief.length === 0) {
    return {
      kind: 'error',
      text: 'Give a brief. Example: /agents-group-work build the site with one builder and one critic.',
    }
  }

  const instruction = [
    'Run this brief as a group-work room.',
    '',
    `Brief: ${brief}`,
    '',
    'Call room_open now. Choose the member count, the member names, and the stop condition yourself.',
    'Pass the job as goal and the stop condition as stopWhen. Do not ask the user for them.',
    'Do not open a second room when this session already has one.',
  ].join('\n')

  invocation.agent.followup(pluginMessage(instruction, 'instructions'))
  return { kind: 'success', text: `Room brief sent to the chair.\n\n${instruction}` }
}
