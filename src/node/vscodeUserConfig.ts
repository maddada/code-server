import { field, logger } from "@coder/logger"
import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"

export const linkedVSCodeUserConfigEntries = ["settings.json", "keybindings.json", "snippets", "mcp.json", "tasks.json"]

export function defaultVSCodeUserConfigDir(): string {
  switch (os.platform()) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Code", "User")
    case "win32":
      return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Code", "User")
    default:
      return path.join(os.homedir(), ".config", "Code", "User")
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

async function isSymlinkTo(source: string, target: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(target)
    if (!stat.isSymbolicLink()) {
      return false
    }
    return path.resolve(path.dirname(target), await fs.readlink(target)) === source
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

export async function linkVSCodeUserConfig(options: {
  sourceDir?: string
  userDataDir: string
  now?: Date
}): Promise<void> {
  const sourceDir = path.resolve(options.sourceDir || defaultVSCodeUserConfigDir())
  const userDir = path.join(options.userDataDir, "User")
  const backupSuffix = (options.now || new Date())
    .toISOString()
    .replace(/[-:.]/g, "")
    .replace("T", "T")
    .replace("Z", "")

  await fs.mkdir(userDir, { recursive: true })

  for (const entry of linkedVSCodeUserConfigEntries) {
    const source = path.join(sourceDir, entry)
    const target = path.join(userDir, entry)

    if (!(await pathExists(source))) {
      logger.debug("Skipping missing VS Code user config entry", field("source", source))
      continue
    }

    if (await isSymlinkTo(source, target)) {
      continue
    }

    if (await pathExists(target)) {
      const backup = path.join(userDir, `${entry}.backup.${backupSuffix}`)
      await fs.rename(target, backup)
      logger.info(`Backed up existing code-server ${entry} to ${backup}`)
    }

    const stat = await fs.lstat(source)
    await fs.symlink(source, target, stat.isDirectory() && os.platform() === "win32" ? "junction" : undefined)
    logger.info(`Linked code-server ${entry} to ${source}`)
  }
}
