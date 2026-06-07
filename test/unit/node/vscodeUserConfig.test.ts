import { promises as fs } from "fs"
import * as path from "path"
import { linkVSCodeUserConfig } from "../../../src/node/vscodeUserConfig"
import { tmpdir } from "../../utils/helpers"

jest.mock("@coder/logger", () => ({
  field: jest.fn((name, value) => ({ name, value })),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
  },
}))

describe("linkVSCodeUserConfig", () => {
  it("links supported VS Code user config entries and backs up existing targets", async () => {
    const sourceDir = await tmpdir("vscode-user-config-source")
    const userDataDir = await tmpdir("vscode-user-config-target")
    const userDir = path.join(userDataDir, "User")

    await fs.mkdir(path.join(sourceDir, "snippets"), { recursive: true })
    await fs.writeFile(path.join(sourceDir, "settings.json"), "{}")
    await fs.writeFile(path.join(sourceDir, "keybindings.json"), "[]")
    await fs.writeFile(path.join(sourceDir, "mcp.json"), "{}")
    await fs.writeFile(path.join(sourceDir, "tasks.json"), "{}")
    await fs.writeFile(path.join(sourceDir, "snippets", "typescript.json"), "{}")

    await fs.mkdir(userDir, { recursive: true })
    await fs.writeFile(path.join(userDir, "settings.json"), '{"old":true}')

    await linkVSCodeUserConfig({
      sourceDir,
      userDataDir,
      now: new Date("2026-05-06T09:00:00.000Z"),
    })

    await expect(fs.readlink(path.join(userDir, "settings.json"))).resolves.toBe(path.join(sourceDir, "settings.json"))
    await expect(fs.readlink(path.join(userDir, "keybindings.json"))).resolves.toBe(
      path.join(sourceDir, "keybindings.json"),
    )
    await expect(fs.readlink(path.join(userDir, "snippets"))).resolves.toBe(path.join(sourceDir, "snippets"))
    await expect(fs.readlink(path.join(userDir, "mcp.json"))).resolves.toBe(path.join(sourceDir, "mcp.json"))
    await expect(fs.readlink(path.join(userDir, "tasks.json"))).resolves.toBe(path.join(sourceDir, "tasks.json"))

    await expect(fs.readFile(path.join(userDir, "settings.json.backup.20260506T090000000"), "utf8")).resolves.toBe(
      '{"old":true}',
    )
  })

  it("leaves existing targets alone when the source entry is missing", async () => {
    const sourceDir = await tmpdir("vscode-user-config-missing-source")
    const userDataDir = await tmpdir("vscode-user-config-missing-target")
    const userDir = path.join(userDataDir, "User")

    await fs.mkdir(sourceDir, { recursive: true })
    await fs.mkdir(userDir, { recursive: true })
    await fs.writeFile(path.join(userDir, "tasks.json"), '{"codeServer":true}')

    await linkVSCodeUserConfig({ sourceDir, userDataDir })

    await expect(fs.readFile(path.join(userDir, "tasks.json"), "utf8")).resolves.toBe('{"codeServer":true}')
  })
})
