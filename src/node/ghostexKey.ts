import { logger } from "@coder/logger"
import * as crypto from "crypto"
import * as express from "express"
import { HttpCode, HttpError } from "../common/http"

/**
 * The query parameter Ghostex adds to the first page load of a launch.
 */
export const GHOSTEX_KEY_QUERY = "ghostex-key"

/**
 * The environment variable Ghostex passes the per-launch key in.
 */
export const GHOSTEX_KEY_ENV = "GHOSTEX_CODE_SERVER_KEY"

/**
 * The launch-key cookie's name before the port the browser used.
 */
export const GHOSTEX_KEY_COOKIE_PREFIX = "ghostex-code-key-"

/**
 * Reads the per-launch key and removes it from the environment, so terminals
 * and the extension host this server starts never see it. Undefined when
 * Ghostex did not start this server with one.
 */
export function takeGhostexKey(): string | undefined {
  const key = process.env[GHOSTEX_KEY_ENV]?.trim()
  delete process.env[GHOSTEX_KEY_ENV]
  if (!key) {
    return undefined
  }
  if (key.length < 32) {
    throw new Error(`${GHOSTEX_KEY_ENV} is too short to be a Ghostex launch key.`)
  }
  return key
}

/*
 * CDXC:CodeEditor 2026-10-25 DECISION:
 * User (security audit, Q10 "build the per-launch key"): the Code view's editor
 * served every route with `--auth none` on a fixed loopback port, so another
 * account on the computer, or another user of a shared remote host, could use
 * it as the Ghostex user. Each launch now gets a random key from Ghostex in
 * GHOSTEX_CODE_SERVER_KEY. Every HTTP and WebSocket route (the workbench, its
 * file and terminal channels, secret storage, /proxy) needs the key in a cookie
 * named for the port the browser used; the first page load carries it as
 * ?ghostex-key=, which sets the cookie and redirects to the same address
 * without it. The Host must be a loopback name, which also stops DNS rebinding.
 * /healthz stays open because Ghostex's readiness probe has no cookie and the
 * answer only says the editor is up. A server started without the variable
 * behaves as before, so an older Ghostex keeps working with this build.
 * SEE-ALSO: apps/desktop/src/app/helpers/source_server/code_server.rs in the Ghostex repo (the key and the URL).
 */
export function ghostexKeyGate(key: string): express.RequestHandler {
  logger.info("Ghostex launch key required for every request")
  const expected = Buffer.from(key, "utf8")
  const matches = (presented: unknown): boolean => {
    if (typeof presented !== "string") {
      return false
    }
    const candidate = Buffer.from(presented, "utf8")
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)
  }

  return (req, res, next) => {
    if (/^\/healthz\/?$/.test(req.path)) {
      return next()
    }
    const host = loopbackHost(req.headers.host)
    if (!host) {
      throw new HttpError("Forbidden", HttpCode.Forbidden)
    }
    const cookieName = `${GHOSTEX_KEY_COOKIE_PREFIX}${host.port}`
    if (matches(req.cookies?.[cookieName])) {
      return next()
    }
    if (!matches(req.query[GHOSTEX_KEY_QUERY])) {
      throw new HttpError("Forbidden", HttpCode.Forbidden)
    }
    // A WebSocket upgrade has no real response to carry a cookie.
    if ((req as { ws?: unknown }).ws) {
      return next()
    }
    res.cookie(cookieName, key, { httpOnly: true, sameSite: "strict", path: "/" })
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next()
    }
    // The rest of the address is kept as sent (the workbench reads ?folder= itself).
    const queryStart = req.originalUrl.indexOf("?")
    const path = queryStart === -1 ? req.originalUrl : req.originalUrl.slice(0, queryStart)
    const kept = (queryStart === -1 ? "" : req.originalUrl.slice(queryStart + 1))
      .split("&")
      .filter((part) => part !== "" && part.split("=")[0] !== GHOSTEX_KEY_QUERY)
    // A leading // would make the redirect leave this host.
    const location = `/${path.replace(/^[/\\]+/, "")}${kept.length > 0 ? `?${kept.join("&")}` : ""}`
    res.redirect(HttpCode.Redirect, location)
  }
}

/**
 * The port of a loopback Host header (127.0.0.1, localhost or [::1]), or
 * undefined for any other host.
 */
function loopbackHost(header: string | undefined): { port: string } | undefined {
  if (!header) {
    return undefined
  }
  const match = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(header.trim())
  if (!match) {
    return undefined
  }
  return { port: match[2] ?? "80" }
}
