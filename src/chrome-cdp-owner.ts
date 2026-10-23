/**
 * Ownership proof for a user-owned Chrome that is reached over the browser
 * DevTools WebSocket.
 *
 * Chrome 136+ ignores `--remote-debugging-port` and `--remote-debugging-pipe`
 * for the default user-data-dir. For a real profile the only sanctioned route
 * is the toggle at `chrome://inspect/#remote-debugging` ("Allow remote
 * debugging for this browser instance"). On that route Chrome serves ONLY the
 * browser WebSocket: `/json/version`, `/json/list` and the other HTTP
 * discovery endpoints answer 404, so they cannot be used to ask the port who
 * owns it.
 *
 * Ownership is therefore proved from three independent facts:
 *
 *   1. the port and the browser target path come from
 *      `<user-data-dir>/DevToolsActivePort`, a file Chrome writes only for a
 *      start that already had the toggle on;
 *   2. the listening socket on that port belongs to a Chrome process whose argv
 *      names the same `--user-data-dir` (argv profile + port);
 *   3. the socket owner is resolved by socket inode, so the port cannot be
 *      silently taken over by another process that merely inherited the port.
 *
 * Every failure is reported with a concrete reason instead of a generic
 * "connection failed".
 */

import { readFile, readdir, readlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

/** The browser endpoint described by one `DevToolsActivePort` file. */
export interface DevToolsEndpoint {
  readonly port: number;
  readonly browserTargetPath: string;
}

/** The process that owns the listening socket on a DevTools port. */
export interface ChromeSocketOwner {
  readonly pid: number;
  /**
   * Exact argv tokens, when the OS exposes them (Linux `/proc/<pid>/cmdline`).
   * Empty on platforms that only report a reconstructed command line.
   */
  readonly argv: readonly string[];
  /** The raw command line of the owner. */
  readonly command: string;
  /** Stable identity of the listening socket, inode-based where the OS exposes it. */
  readonly socketIdentity: string;
}

/** Result of a successful ownership proof. */
export interface ChromeOwnershipProof {
  readonly endpoint: DevToolsEndpoint;
  readonly owner: ChromeSocketOwner;
  readonly profileDir: string;
}

/** A refusal that names the exact reason the Chrome could not be proven. */
export class ChromeCdpOwnershipError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "ChromeCdpOwnershipError";
  }
}

/** Resolve the socket owner of a listening TCP port, or null when nobody listens. */
export type SocketOwnerProbe = (port: number) => Promise<ChromeSocketOwner | null>;

/** Options accepted by {@link proveChromeOwnership}. */
export interface ChromeOwnershipOptions {
  /** The Chrome user-data-dir that must own the port. */
  readonly profileDir: string;
  /** Override the socket owner lookup (tests, unusual platforms). */
  readonly probe?: SocketOwnerProbe;
  /** Read the DevToolsActivePort file (tests). */
  readonly readEndpointFile?: (profileDir: string) => Promise<string>;
}

/** Parse the two-line `DevToolsActivePort` file into a browser endpoint. */
export function parseDevToolsActivePort(content: string): DevToolsEndpoint {
  const lines = content.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new ChromeCdpOwnershipError(
      "chrome_cdp_active_port_invalid",
      "DevToolsActivePort is malformed: expected a port line and a /devtools/browser/<uuid> line",
    );
  }
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ChromeCdpOwnershipError(
      "chrome_cdp_active_port_invalid",
      `DevToolsActivePort holds an invalid debugging port: ${JSON.stringify(lines[0])}`,
    );
  }
  const browserTargetPath = lines[1]!;
  if (!browserTargetPath.startsWith("/devtools/browser/")) {
    throw new ChromeCdpOwnershipError(
      "chrome_cdp_active_port_invalid",
      `DevToolsActivePort holds an invalid browser target path: ${JSON.stringify(browserTargetPath)}`,
    );
  }
  return { port, browserTargetPath };
}

/** Default Chrome profile directory of the current platform. */
export function defaultChromeProfileDir(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform() === "linux") return join(home, ".config", "google-chrome");
  return join(home, ".config", "google-chrome");
}

/** Read and parse the DevToolsActivePort file of one profile directory. */
export async function readDevToolsEndpoint(profileDir: string): Promise<DevToolsEndpoint> {
  let content: string;
  try {
    content = await readFile(join(profileDir, "DevToolsActivePort"), "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ChromeCdpOwnershipError(
        "chrome_cdp_active_port_missing",
        `Chrome access unavailable: ${join(profileDir, "DevToolsActivePort")} is missing. Start Chrome with "Allow remote debugging for this browser instance" enabled at chrome://inspect/#remote-debugging, or pass a profile that has it.`,
      );
    }
    throw new ChromeCdpOwnershipError(
      "chrome_cdp_active_port_unreadable",
      `Chrome access unavailable: ${join(profileDir, "DevToolsActivePort")} could not be read (${code ?? "unknown error"}).`,
    );
  }
  return parseDevToolsActivePort(content);
}

/** Look up the inode of a listening TCP port in `/proc/net/tcp`. */
async function linuxListeningInode(port: number): Promise<string | undefined> {
  const hexPort = port.toString(16).padStart(4, "0");
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let table: string;
    try {
      table = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of table.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/u);
      if (parts.length < 10) continue;
      const local = parts[1]!;
      const state = parts[3]!;
      if (state !== "0A") continue;
      if (local.split(":")[1] !== hexPort) continue;
      const inode = parts[9]!;
      if (inode) return inode;
    }
  }
  return undefined;
}

/** Find the process that owns one socket inode on Linux. */
async function linuxPidForInode(inode: string): Promise<number | undefined> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    let descriptors: string[];
    try {
      descriptors = await readdir(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      let link: string;
      try {
        link = await readlink(`/proc/${entry}/fd/${descriptor}`);
      } catch {
        continue;
      }
      if (link === `socket:[${inode}]`) return Number(entry);
    }
  }
  return undefined;
}

/** Read the argv of one process on Linux. */
async function linuxArgv(pid: number): Promise<string[]> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf-8");
    return raw.split("\0").filter((part) => part.length > 0);
  } catch {
    return [];
  }
}

/** Look up the socket owner on Linux through /proc and the socket inode. */
export async function linuxSocketOwnerProbe(port: number): Promise<ChromeSocketOwner | null> {
  const inode = await linuxListeningInode(port);
  if (!inode) return null;
  const pid = await linuxPidForInode(inode);
  if (pid === undefined) return null;
  const argv = await linuxArgv(pid);
  return { pid, argv, command: argv.join(" "), socketIdentity: `inode:${inode}` };
}

/** Run one helper binary and return its stdout, or null when it is unavailable. */
async function runHelper(binary: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, args, { encoding: "utf-8", timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/** Look up the socket owner on macOS through lsof and ps. */
export async function darwinSocketOwnerProbe(port: number): Promise<ChromeSocketOwner | null> {
  const listing = await runHelper("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"]);
  if (!listing) return null;
  const fields = listing.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  let pid: number | undefined;
  let descriptor: string | undefined;
  let address: string | undefined;
  for (const field of fields) {
    if (field.startsWith("p")) pid = Number(field.slice(1));
    else if (field.startsWith("f")) descriptor = field.slice(1);
    else if (field.startsWith("n")) address = field.slice(1);
  }
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return null;
  // macOS reconstructs the command line from argv and does not quote paths, so
  // a path that contains spaces cannot be split back into exact tokens. The
  // raw command line is therefore kept and matched as a whole.
  const command = (await runHelper("/bin/ps", ["-p", String(pid), "-o", "command="]))?.trim() ?? "";
  return {
    pid,
    argv: [],
    command,
    socketIdentity: `lsof:${address ?? `127.0.0.1:${port}`}${descriptor ? `:fd${descriptor}` : ""}`,
  };
}

/** Socket owner lookup for the current platform. */
export const systemSocketOwnerProbe: SocketOwnerProbe = async (port) => {
  if (platform() === "linux") return linuxSocketOwnerProbe(port);
  if (platform() === "darwin") return darwinSocketOwnerProbe(port);
  return null;
};

/** Extract the `--user-data-dir` value from exact argv tokens. */
export function argvUserDataDir(argv: readonly string[]): string | undefined {
  for (const argument of argv) {
    if (argument.startsWith("--user-data-dir=")) return argument.slice("--user-data-dir=".length);
  }
  return undefined;
}

/**
 * Extract the `--user-data-dir` value from a raw command line.
 *
 * The value ends at the next flag, so a profile path that contains spaces
 * stays intact.
 */
export function commandUserDataDir(command: string): string | undefined {
  const marker = "--user-data-dir=";
  const index = command.indexOf(marker);
  if (index < 0) return undefined;
  const rest = command.slice(index + marker.length);
  const next = rest.search(/\s--/u);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** Decide whether the socket owner is the expected Chrome profile. */
export function ownerMatchesProfile(owner: ChromeSocketOwner, profileDir: string): { ok: boolean; reason?: string } {
  const binary = owner.argv[0] ?? owner.command;
  if (!/chrome|chromium/iu.test(binary) && !/chrome|chromium/iu.test(owner.command)) {
    return { ok: false, reason: `the listening process is not Chrome (${owner.command || binary})` };
  }
  const declared = argvUserDataDir(owner.argv) ?? commandUserDataDir(owner.command);
  if (declared === undefined) return { ok: true };
  if (resolve(declared) !== resolve(profileDir)) {
    return {
      ok: false,
      reason: `the listening Chrome owns profile ${declared} instead of ${profileDir}`,
    };
  }
  return { ok: true };
}

/**
 * Prove that the browser endpoint in `DevToolsActivePort` belongs to the
 * expected Chrome profile.
 */
export async function proveChromeOwnership(options: ChromeOwnershipOptions): Promise<ChromeOwnershipProof> {
  const profileDir = resolve(options.profileDir);
  const endpoint = options.readEndpointFile
    ? parseDevToolsActivePort(await options.readEndpointFile(profileDir))
    : await readDevToolsEndpoint(profileDir);
  const probe = options.probe ?? systemSocketOwnerProbe;
  const owner = await probe(endpoint.port);
  if (!owner) {
    throw new ChromeCdpOwnershipError(
      "chrome_cdp_socket_owner_missing",
      `Chrome access unavailable: nothing is listening on the DevTools port ${endpoint.port} recorded in ${join(profileDir, "DevToolsActivePort")}.`,
    );
  }
  const match = ownerMatchesProfile(owner, profileDir);
  if (!match.ok) {
    throw new ChromeCdpOwnershipError(
      "chrome_cdp_socket_owner_mismatch",
      `Chrome access unavailable: ${match.reason} (pid ${owner.pid} owns the DevTools port ${endpoint.port}).`,
    );
  }
  return { endpoint, owner, profileDir };
}
