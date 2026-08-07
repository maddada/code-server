import * as httpserver from "../../../utils/httpserver"
import * as integration from "../../../utils/integration"

describe("health", () => {
  let codeServer: httpserver.HttpServer | undefined
  const sessionSocket = `/tmp/code-server-health-${process.pid}.sock`

  afterEach(async () => {
    if (codeServer) {
      await codeServer.dispose()
      codeServer = undefined
    }
  })

  it("/healthz", async () => {
    codeServer = await integration.setup(["--auth=none", `--session-socket=${sessionSocket}`], "")
    const resp = await codeServer.fetch("/healthz")
    expect(resp.status).toBe(200)
    const json = await resp.json()
    expect(json).toStrictEqual({ lastHeartbeat: 0, promptEditorIpcReady: true, status: "expired" })
  })

  it("/healthz (websocket)", async () => {
    codeServer = await integration.setup(["--auth=none", `--session-socket=${sessionSocket}`], "")
    const ws = codeServer.ws("/healthz")
    const message = await new Promise((resolve, reject) => {
      ws.on("error", (err) => {
        console.error("[healthz]", err)
      })
      ws.on("message", (message) => {
        try {
          const j = JSON.parse(message.toString())
          resolve(j)
        } catch (error) {
          reject(error)
        }
      })
      ws.on("open", () => ws.send(JSON.stringify({ event: "health" })))
    })
    ws.terminate()
    expect(message).toStrictEqual({
      event: "health",
      status: "expired",
      lastHeartbeat: 0,
      promptEditorIpcReady: true,
    })
  })
})
