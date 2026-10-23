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
export declare class ChromeCdpOwnershipError extends Error {
    readonly reason: string;
    constructor(reason: string, message: string);
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
export declare function parseDevToolsActivePort(content: string): DevToolsEndpoint;
/** Default Chrome profile directory of the current platform. */
export declare function defaultChromeProfileDir(): string;
/** Read and parse the DevToolsActivePort file of one profile directory. */
export declare function readDevToolsEndpoint(profileDir: string): Promise<DevToolsEndpoint>;
/** Look up the socket owner on Linux through /proc and the socket inode. */
export declare function linuxSocketOwnerProbe(port: number): Promise<ChromeSocketOwner | null>;
/** Look up the socket owner on macOS through lsof and ps. */
export declare function darwinSocketOwnerProbe(port: number): Promise<ChromeSocketOwner | null>;
/** Socket owner lookup for the current platform. */
export declare const systemSocketOwnerProbe: SocketOwnerProbe;
/** Extract the `--user-data-dir` value from exact argv tokens. */
export declare function argvUserDataDir(argv: readonly string[]): string | undefined;
/**
 * Extract the `--user-data-dir` value from a raw command line.
 *
 * The value ends at the next flag, so a profile path that contains spaces
 * stays intact.
 */
export declare function commandUserDataDir(command: string): string | undefined;
/** Decide whether the socket owner is the expected Chrome profile. */
export declare function ownerMatchesProfile(owner: ChromeSocketOwner, profileDir: string): {
    ok: boolean;
    reason?: string;
};
/**
 * Prove that the browser endpoint in `DevToolsActivePort` belongs to the
 * expected Chrome profile.
 */
export declare function proveChromeOwnership(options: ChromeOwnershipOptions): Promise<ChromeOwnershipProof>;
