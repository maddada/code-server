import { logger } from "@coder/logger"
import express from "express"
import * as http from "http"
import * as path from "path"
import { HttpCode, HttpError } from "../common/http"
import { listen } from "./app"
import { errorHandler } from "./routes/errors"
import { canConnect } from "./util"

export interface EditorSessionEntry {
  workspace: {
    id: string
    folders: {
      uri: {
        path: string
      }
    }[]
  }

  socketPath: string
}

interface DeleteSessionRequest {
  socketPath?: string
}

interface AddSessionRequest {
  entry?: EditorSessionEntry
}

interface GetSessionResponse {
  socketPath?: string
}

/** Arguments supported by a running Code workbench's CLI socket. */
export interface OpenCommandPipeArgs {
  type: "open"
  fileURIs?: string[]
  folderURIs: string[]
  forceNewWindow?: boolean
  diffMode?: boolean
  addMode?: boolean
  gotoLineMode?: boolean
  forceReuseWindow?: boolean
  waitMarkerFilePath?: string
}

interface QueueOpenRequest {
  filePath: string
  pipeArgs: OpenCommandPipeArgs
  requestKey: string
  /**
   * CDXC:CodeEditor 2026-09-11 WHY:
   * A queued open used to be delivered only to a workbench whose workspace folder contained the file, so a file outside the project (a home-folder config, a file from another checkout) matched nothing and sat in the queue forever while the app had already announced "Opening file in Code view".
   * The caller that knows which project's Code view it just switched to names that folder here, and the request is delivered to the workbench rooted at it regardless of where the file lives.
   */
  workspaceFolder?: string
}

interface QueueOpenResponse {
  status: "opened" | "replaced"
}

interface PendingQueueOpenRequest extends QueueOpenRequest {
  settle(status: QueueOpenResponse["status"]): void
}

function isQueueOpenRequest(value: unknown): value is QueueOpenRequest {
  if (!value || typeof value !== "object") {
    return false
  }
  const request = value as Partial<QueueOpenRequest>
  return (
    typeof request.filePath === "string" &&
    request.filePath.length > 0 &&
    typeof request.requestKey === "string" &&
    request.requestKey.length > 0 &&
    request.requestKey.length <= 128 &&
    (request.workspaceFolder === undefined ||
      (typeof request.workspaceFolder === "string" && request.workspaceFolder.length > 0)) &&
    request.pipeArgs?.type === "open" &&
    Array.isArray(request.pipeArgs.folderURIs) &&
    request.pipeArgs.folderURIs.every((uri) => typeof uri === "string") &&
    (request.pipeArgs.fileURIs === undefined ||
      (Array.isArray(request.pipeArgs.fileURIs) && request.pipeArgs.fileURIs.every((uri) => typeof uri === "string")))
  )
}

export function sendOpenCommand(socketPath: string, pipeArgs: OpenCommandPipeArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        path: "/",
        method: "POST",
        socketPath,
      },
      (response) => {
        response.resume()
        response.on("end", () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve()
          } else {
            reject(new Error(`Unexpected workbench response status: ${response.statusCode || "unknown"}`))
          }
        })
      },
    )
    request.on("error", reject)
    request.write(JSON.stringify(pipeArgs))
    request.end()
  })
}

export async function makeEditorSessionManagerServer(
  codeServerSocketPath: string,
  editorSessionManager: EditorSessionManager,
): Promise<{ server: http.Server; promptEditorIpcReady: boolean }> {
  const router = express()

  router.use(express.json())

  router.get<{}, GetSessionResponse | string | unknown, undefined, { filePath?: string }>(
    "/session",
    async (req, res) => {
      const filePath = req.query.filePath
      if (!filePath) {
        throw new HttpError("filePath is required", HttpCode.BadRequest)
      }
      const socketPath = await editorSessionManager.getConnectedSocketPath(filePath)
      const response: GetSessionResponse = { socketPath }
      res.json(response)
    },
  )

  router.post<{}, string, AddSessionRequest | undefined>("/add-session", async (req, res) => {
    const entry = req.body?.entry
    if (!entry) {
      throw new HttpError("entry is required", HttpCode.BadRequest)
    }
    await editorSessionManager.addSession(entry)
    res.status(200).send("session added")
  })

  router.post<{}, QueueOpenResponse | string, QueueOpenRequest | undefined>("/queue-open", async (req, res) => {
    if (!isQueueOpenRequest(req.body)) {
      throw new HttpError("a valid queued open request is required", HttpCode.BadRequest)
    }
    const status = await editorSessionManager.queueOpen(req.body)
    res.status(200).json({ status })
  })

  router.post<{}, string, DeleteSessionRequest | undefined>("/delete-session", async (req, res) => {
    const socketPath = req.body?.socketPath
    if (!socketPath) {
      throw new HttpError("socketPath is required", HttpCode.BadRequest)
    }
    editorSessionManager.deleteSession(socketPath)
    res.status(200).send("session deleted")
  })

  router.use(errorHandler)

  const server = http.createServer(router)
  try {
    await listen(server, { socket: codeServerSocketPath })
  } catch (e) {
    logger.warn(`Could not create socket at ${codeServerSocketPath}`)
  }
  return {
    server,
    promptEditorIpcReady: server.address() === codeServerSocketPath,
  }
}

export class EditorSessionManager {
  // Map from socket path to EditorSessionEntry.
  private entries = new Map<string, EditorSessionEntry>()
  private pendingOpenRequests = new Map<string, PendingQueueOpenRequest>()
  private pendingOpenFlush: Promise<void> | undefined
  private pendingOpenFlushAgain = false

  async addSession(entry: EditorSessionEntry): Promise<void> {
    logger.debug(`Adding session to session registry: ${entry.socketPath}`)
    this.entries.set(entry.socketPath, entry)
    await this.flushPendingOpenRequests()
  }

  getCandidatesForFile(filePath: string, matchingWorkspaceOnly = false): EditorSessionEntry[] {
    const matchCheckResults = new Map<string, boolean>()

    const checkMatch = (entry: EditorSessionEntry): boolean => {
      if (matchCheckResults.has(entry.socketPath)) {
        return matchCheckResults.get(entry.socketPath)!
      }
      const result = entry.workspace.folders.some((folder) => filePath.startsWith(folder.uri.path + path.sep))
      matchCheckResults.set(entry.socketPath, result)
      return result
    }

    const candidates = Array.from(this.entries.values())
      .reverse() // Most recently registered first.
      .sort((a, b) => {
        // Matches first.
        const aMatch = checkMatch(a)
        const bMatch = checkMatch(b)
        if (aMatch === bMatch) {
          return 0
        }
        if (aMatch) {
          return -1
        }
        return 1
      })
    return matchingWorkspaceOnly ? candidates.filter(checkMatch) : candidates
  }

  /** Workbenches rooted at exactly this folder, most recently registered first. */
  getCandidatesForWorkspaceFolder(workspaceFolder: string): EditorSessionEntry[] {
    const normalize = (value: string): string => {
      const trimmed = value.replace(/[\\/]+$/, "")
      return trimmed.length > 0 ? trimmed : value
    }
    const wanted = normalize(workspaceFolder)
    return Array.from(this.entries.values())
      .reverse() // Most recently registered first.
      .filter((entry) => entry.workspace.folders.some((folder) => normalize(folder.uri.path) === wanted))
  }

  deleteSession(socketPath: string): void {
    logger.debug(`Deleting session from session registry: ${socketPath}`)
    this.entries.delete(socketPath)
  }

  /**
   * Returns the best socket path that we can connect to.
   * We also delete any sockets that we can't connect to.
   */
  async getConnectedSocketPath(filePath: string): Promise<string | undefined> {
    return this.getConnectedSocketPathForCandidates(this.getCandidatesForFile(filePath))
  }

  async queueOpen(request: QueueOpenRequest): Promise<QueueOpenResponse["status"]> {
    return new Promise((resolve) => {
      this.pendingOpenRequests.get(request.requestKey)?.settle("replaced")
      this.pendingOpenRequests.set(request.requestKey, { ...request, settle: resolve })
      void this.flushPendingOpenRequests()
    })
  }

  private async getConnectedSocketPathForCandidates(candidates: EditorSessionEntry[]): Promise<string | undefined> {
    let match: EditorSessionEntry | undefined = undefined

    for (const candidate of candidates) {
      if (await canConnect(candidate.socketPath)) {
        match = candidate
        break
      }
      this.deleteSession(candidate.socketPath)
    }

    return match?.socketPath
  }

  private flushPendingOpenRequests(): Promise<void> {
    if (this.pendingOpenFlush) {
      this.pendingOpenFlushAgain = true
      return this.pendingOpenFlush
    }
    this.pendingOpenFlush = (async () => {
      do {
        this.pendingOpenFlushAgain = false
        for (const [requestKey, request] of Array.from(this.pendingOpenRequests.entries())) {
          const socketPath = await this.getConnectedSocketPathForCandidates(
            request.workspaceFolder
              ? this.getCandidatesForWorkspaceFolder(request.workspaceFolder)
              : this.getCandidatesForFile(request.filePath, true),
          )
          if (!socketPath || this.pendingOpenRequests.get(requestKey) !== request) {
            continue
          }
          try {
            await sendOpenCommand(socketPath, request.pipeArgs)
            if (this.pendingOpenRequests.get(requestKey) === request) {
              this.pendingOpenRequests.delete(requestKey)
              request.settle("opened")
            }
          } catch {
            this.deleteSession(socketPath)
            this.pendingOpenFlushAgain = true
          }
        }
      } while (this.pendingOpenFlushAgain)
    })().finally(() => {
      this.pendingOpenFlush = undefined
    })
    return this.pendingOpenFlush
  }
}

export class EditorSessionManagerClient {
  constructor(private codeServerSocketPath: string) {}

  async canConnect() {
    return canConnect(this.codeServerSocketPath)
  }

  async getConnectedSocketPath(filePath: string): Promise<string | undefined> {
    const response = await new Promise<GetSessionResponse>((resolve, reject) => {
      const opts = {
        path: "/session?filePath=" + encodeURIComponent(filePath),
        socketPath: this.codeServerSocketPath,
        method: "GET",
      }
      const req = http.request(opts, (res) => {
        let rawData = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => {
          rawData += chunk
        })
        res.on("end", () => {
          try {
            const obj = JSON.parse(rawData)
            if (res.statusCode === 200) {
              resolve(obj)
            } else {
              reject(new Error("Unexpected status code: " + res.statusCode))
            }
          } catch (e: unknown) {
            reject(e)
          }
        })
      })
      req.on("error", reject)
      req.end()
    })
    return response.socketPath
  }

  async queueOpen(request: QueueOpenRequest): Promise<QueueOpenResponse["status"]> {
    const response = await new Promise<QueueOpenResponse>((resolve, reject) => {
      const req = http.request(
        {
          path: "/queue-open",
          socketPath: this.codeServerSocketPath,
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
        },
        (res) => {
          let rawData = ""
          res.setEncoding("utf8")
          res.on("data", (chunk) => {
            rawData += chunk
          })
          res.on("end", () => {
            try {
              const result = JSON.parse(rawData)
              if (res.statusCode === 200) {
                resolve(result)
              } else {
                reject(new Error("Unexpected status code: " + res.statusCode))
              }
            } catch (error: unknown) {
              reject(error)
            }
          })
        },
      )
      req.on("error", reject)
      req.write(JSON.stringify(request))
      req.end()
    })
    return response.status
  }

  // Currently only used for tests.
  async addSession(request: AddSessionRequest): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const opts = {
        path: "/add-session",
        socketPath: this.codeServerSocketPath,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
      }
      const req = http.request(opts, () => {
        resolve()
      })
      req.on("error", reject)
      req.write(JSON.stringify(request))
      req.end()
    })
  }
}
