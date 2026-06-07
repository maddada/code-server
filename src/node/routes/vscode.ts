import { logger } from "@coder/logger"
import * as express from "express"
import { promises as fs } from "fs"
import * as http from "http"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { logError } from "../../common/util"
import { CodeArgs, toCodeArgs } from "../cli"
import { isDevMode, vsRootPath } from "../constants"
import { authenticated, ensureAuthenticated, ensureOrigin, redirect, replaceTemplates, self } from "../http"
import { SocketProxyProvider } from "../socket"
import { isFile } from "../util"
import { type WebsocketRequest, Router as WsRouter } from "../wsRouter"

export const router = express.Router()

export const wsRouter = WsRouter()

type SecretStorageRequest = {
  op?: unknown
  key?: unknown
  value?: unknown
}

type SecretStorageData = Record<string, string>

const secretStorageFileName = "code-server-secret-storage.json"
const maxSecretKeyLength = 8192
let secretStorageQueue = Promise.resolve()

const getSecretStoragePath = (req: express.Request): string => {
  return path.join(req.args["user-data-dir"], secretStorageFileName)
}

const isValidSecretKey = (key: unknown): key is string => {
  return typeof key === "string" && key.length > 0 && key.length <= maxSecretKeyLength
}

const readSecretStorage = async (req: express.Request): Promise<SecretStorageData> => {
  const secretStoragePath = getSecretStoragePath(req)
  try {
    const raw = await fs.readFile(secretStoragePath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("secret storage file must contain an object")
    }
    const entries = Object.entries(parsed)
    if (entries.some(([, value]) => typeof value !== "string")) {
      throw new Error("secret storage file must only contain string values")
    }
    return Object.fromEntries(entries) as SecretStorageData
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return {}
    }
    throw error
  }
}

const writeSecretStorage = async (req: express.Request, data: SecretStorageData): Promise<void> => {
  const secretStoragePath = getSecretStoragePath(req)
  const temporaryPath = `${secretStoragePath}.${process.pid}.tmp`
  await fs.mkdir(path.dirname(secretStoragePath), { recursive: true, mode: 0o700 })
  await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.rename(temporaryPath, secretStoragePath)
  await fs.chmod(secretStoragePath, 0o600)
}

const withSecretStorage = async <T>(operation: () => Promise<T>): Promise<T> => {
  const run = secretStorageQueue.then(operation, operation)
  secretStorageQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * The API of VS Code's web client server.  code-server delegates requests to VS
 * Code here.
 *
 * @see ../../../lib/vscode/src/vs/server/node/server.main.ts:72
 */
export interface IVSCodeServerAPI {
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>
  handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void
  handleServerError(err: Error): void
  dispose(): void
}

/**
 * VS Code's CLI entrypoint (../../../lib/vscode/src/server-main.js).
 *
 * Normally VS Code will run `node server-main.js` which starts either the web
 * server or the CLI (for installing extensions, etc) but we patch it so we can
 * `require` it and call its functions directly in order to integrate with our
 * web server.
 */
export type VSCodeModule = {
  // See ../../../lib/vscode/src/server-main.js:339.
  loadCodeWithNls(): Promise<{
    // See ../../../lib/vscode/src/vs/server/node/server.main.ts:72.
    createServer(address: string | net.AddressInfo | null, args: CodeArgs): Promise<IVSCodeServerAPI>
    // See ../../../lib/vscode/src/vs/server/node/server.main.ts:65.
    spawnCli(args: CodeArgs): Promise<void>
  }>
}

/**
 * Load then create the VS Code server.
 */
async function loadVSCode(req: express.Request): Promise<IVSCodeServerAPI> {
  // Since server-main.js is an ES module, we have to use `import`.  However,
  // tsc will transpile this to `require` unless we change our module type,
  // which will also require that we switch to ESM, since a hybrid approach
  // breaks importing `rotating-file-stream` for some reason.  To work around
  // this, use `eval` for now, but we should consider switching to ESM.
  let modPath = path.join(vsRootPath, "out/server-main.js")
  if (os.platform() === "win32") {
    // On Windows, absolute paths of ESM modules must be a valid file URI.
    modPath = "file:///" + modPath.replace(/\\/g, "/")
  }
  const mod = (await eval(`import("${modPath}")`)) as VSCodeModule
  const serverModule = await mod.loadCodeWithNls()
  return serverModule.createServer(null, {
    ...(await toCodeArgs(req.args)),
    "accept-server-license-terms": true,
    // This seems to be used to make the connection token flags optional (when
    // set to 1.63) but we have always included them.
    compatibility: "1.64",
    "without-connection-token": true,
  })
}

// To prevent loading the module more than once at a time.  We also have the
// resolved value so you do not need to `await` everywhere.
let vscodeServerPromise: Promise<IVSCodeServerAPI> | undefined

// The resolved value from the dynamically loaded VS Code server.  Do not use
// without first calling and awaiting `ensureCodeServerLoaded`.
let vscodeServer: IVSCodeServerAPI | undefined

/**
 * Ensure the VS Code server is loaded.
 */
export const ensureVSCodeLoaded = async (
  req: express.Request,
  _: express.Response,
  next: express.NextFunction,
): Promise<void> => {
  if (vscodeServer) {
    return next()
  }
  if (!vscodeServerPromise) {
    vscodeServerPromise = loadVSCode(req)
  }
  try {
    vscodeServer = await vscodeServerPromise
  } catch (error) {
    vscodeServerPromise = undefined // Unset so we can try again.
    logError(logger, "CodeServerRouteWrapper", error)
    if (isDevMode) {
      return next(
        new Error(
          (error instanceof Error ? error.message : error) +
            " (Have you applied the patches? If so, VS Code may still be compiling)",
        ),
      )
    }
    return next(error)
  }
  return next()
}

router.get("/", ensureVSCodeLoaded, async (req, res, next) => {
  const isAuthenticated = await authenticated(req)
  const NO_FOLDER_OR_WORKSPACE_QUERY = !req.query.folder && !req.query.workspace
  // Ew means the workspace was closed so clear the last folder/workspace.
  const FOLDER_OR_WORKSPACE_WAS_CLOSED = req.query.ew

  if (!isAuthenticated) {
    const to = self(req)
    return redirect(req, res, "login", {
      to: to !== "/" ? to : undefined,
    })
  }

  if (NO_FOLDER_OR_WORKSPACE_QUERY && !FOLDER_OR_WORKSPACE_WAS_CLOSED) {
    const settings = await req.settings.read()
    const lastOpened = settings.query || {}
    // This flag disables the last opened behavior
    const IGNORE_LAST_OPENED = req.args["ignore-last-opened"]
    const HAS_LAST_OPENED_FOLDER_OR_WORKSPACE = lastOpened.folder || lastOpened.workspace
    const HAS_FOLDER_OR_WORKSPACE_FROM_CLI = req.args._.length > 0
    const to = self(req)

    let folder = undefined
    let workspace = undefined

    // Redirect to the last folder/workspace if nothing else is opened.
    if (HAS_LAST_OPENED_FOLDER_OR_WORKSPACE && !IGNORE_LAST_OPENED) {
      folder = lastOpened.folder
      workspace = lastOpened.workspace
    } else if (HAS_FOLDER_OR_WORKSPACE_FROM_CLI) {
      const lastEntry = path.resolve(req.args._[req.args._.length - 1])
      const entryIsFile = await isFile(lastEntry)
      const IS_WORKSPACE_FILE = entryIsFile && path.extname(lastEntry) === ".code-workspace"

      if (IS_WORKSPACE_FILE) {
        workspace = lastEntry
      } else if (!entryIsFile) {
        folder = lastEntry
      }
    }

    if (folder || workspace) {
      return redirect(req, res, to, {
        folder,
        workspace,
      })
    }
  }

  // Store the query parameters so we can use them on the next load.  This
  // also allows users to create functionality around query parameters.
  await req.settings.write({ query: req.query })

  next()
})

router.get("/manifest.json", async (req, res) => {
  res.writeHead(200, { "Content-Type": "application/manifest+json" })

  res.end(
    replaceTemplates(
      req,
      JSON.stringify(
        {
          name: req.args["app-name"],
          short_name: req.args["app-name"],
          start_url: ".",
          display: "fullscreen",
          display_override: ["window-controls-overlay"],
          description: "Run Code on a remote server.",
          icons: [192, 512]
            .map((size) => [
              {
                src: `{{BASE}}/_static/src/browser/media/pwa-icon-${size}.png`,
                type: "image/png",
                sizes: `${size}x${size}`,
                purpose: "any",
              },
              {
                src: `{{BASE}}/_static/src/browser/media/pwa-icon-maskable-${size}.png`,
                type: "image/png",
                sizes: `${size}x${size}`,
                purpose: "maskable",
              },
            ])
            .flat(),
        },
        null,
        2,
      ),
    ),
  )
})

router.post("/.code-server-secret-storage", ensureOrigin, ensureAuthenticated, async (req, res): Promise<void> => {
  /*
   * CDXC:GitHubAuthentication 2026-05-17-02:48:
   * GitHub OAuth sessions in embedded code-server must persist across ghostex restarts without storing token material in browser localStorage.
   * Keep VS Code SecretStorage on a same-origin, authenticated server endpoint backed by --user-data-dir and owner-only file permissions so extension hosts share the same persisted session store.
   */
  const body = req.body as SecretStorageRequest | undefined
  const op = body?.op

  if (op === "keys") {
    const keys = await withSecretStorage(async () => Object.keys(await readSecretStorage(req)))
    res.json({ keys })
    return
  }

  if (!isValidSecretKey(body?.key)) {
    res.status(400).json({ error: "Invalid secret storage key" })
    return
  }

  const key = body.key
  if (op === "get") {
    const value = await withSecretStorage(async () => (await readSecretStorage(req))[key])
    res.json({ value })
    return
  }

  if (op === "set") {
    if (typeof body.value !== "string") {
      res.status(400).json({ error: "Invalid secret storage value" })
      return
    }
    const value = body.value
    await withSecretStorage(async () => {
      const data = await readSecretStorage(req)
      data[key] = value
      await writeSecretStorage(req, data)
    })
    res.json({})
    return
  }

  if (op === "delete") {
    await withSecretStorage(async () => {
      const data = await readSecretStorage(req)
      delete data[key]
      await writeSecretStorage(req, data)
    })
    res.json({})
    return
  }

  res.status(400).json({ error: "Invalid secret storage operation" })
})

router.all(/.*/, ensureAuthenticated, ensureVSCodeLoaded, async (req, res) => {
  vscodeServer!.handleRequest(req, res)
})

const socketProxyProvider = new SocketProxyProvider()
wsRouter.ws(/.*/, ensureOrigin, ensureAuthenticated, ensureVSCodeLoaded, async (req: WebsocketRequest) => {
  const wrappedSocket = await socketProxyProvider.createProxy(req.ws)
  // This should actually accept a duplex stream but it seems Code has not
  // been updated to match the Node 16 types so cast for now.  There does not
  // appear to be any code specific to sockets so this should be fine.
  vscodeServer!.handleUpgrade(req, wrappedSocket as net.Socket)

  req.ws.resume()
})

export function dispose() {
  vscodeServer?.dispose()
  socketProxyProvider.stop()
}
