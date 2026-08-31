import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { desktopSystemProxyCliDataDir } from '../dev-instance.js';
import { WORKSPACE_APPS_DIR } from '../paths.js';
import { ACTIVE_CONFIG_PATH } from './active-config.js';

const { join, resolve } = path;

export type RuntimeMode = 'connect' | 'system-proxy' | 'tunnel';

export interface RuntimeProcessState {
  mode: RuntimeMode;
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  lastExitCode: number | null;
  lastError: string | null;
}

export interface StartOptions {
  mode: RuntimeMode;
  router?: string;
  dashboardPort?: number;
  configPath?: string;
  verbose?: boolean;
  env?: Record<string, string>;
  // system-proxy-mode options
  systemProxyPeerId?: string;
  systemProxyPort?: number;
  systemProxyProfiles?: string[];
  systemProxyDefaultModel?: string;
  systemProxyServedModels?: string[];
  setSystemProxy?: boolean;
  tunnelBuyerPort?: number;
}

export interface DaemonStateSnapshot {
  exists: boolean;
  state: Record<string, unknown> | null;
}

export interface CliCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MIN_NODE_MAJOR_VERSION = 20;
const DEFAULT_CLI_COMMAND = 'antseed';
const CLI_COMMAND_ENV = 'ANTSEED_CLI_BIN';
const CLI_NODE_BIN_ENV = 'ANTSEED_NODE_BIN';
const LOCAL_CLI_BIN_RELATIVE = ['..', 'cli', 'dist', 'cli', 'index.js'] as const;
const RUNTIME_NATIVE_SCRIPT_RELATIVE = ['scripts', 'ensure-runtime-native-modules.mjs'] as const;
const RUNTIME_NATIVE_MARKER_FILE = '.runtime-native-meta.json';
const DEFAULT_CONFIG_PATH = join(homedir(), '.antseed', 'config.json');
const DEFAULT_CONNECT_DATA_DIR = join(homedir(), '.antseed');
const LEGACY_DESKTOP_DATA_ROOT = join(homedir(), '.antseed-desktop');
const LEGACY_DESKTOP_CONNECT_DATA_DIR = join(LEGACY_DESKTOP_DATA_ROOT, 'connect');
const CONNECT_DATA_DIR_ENV = 'ANTSEED_DESKTOP_CONNECT_DATA_DIR';

function normalizeRouterIdentifier(value: string | undefined): string {
  const raw = (value ?? 'local').trim().toLowerCase();
  if (!raw) return 'local';

  if (
    raw === 'claude-code'
    || raw === '@antseed/router-local'
    || raw === 'antseed-router-local'
    || raw === 'antseed-router-claude-code'
  ) {
    return 'local';
  }

  return raw;
}

/**
 * Applies the Levanto model router only when the user has actually turned it
 * on (Preferences' "Select model router" dropdown, persisted as
 * `buyer.routingPreferences.autoSubscriptionEnabled` -- VprPreferencesView.tsx).
 * That dropdown is the real choice this override used to stand in for before
 * it existed (runlog: "local routing-peer daemon", 2026-08-26); now that it
 * exists, unconditionally forcing router:'levanto' regardless of the user's
 * selection would fight it -- worse, it would force *every* connect-mode
 * start (including a genuine mainnet buyer with the dropdown left on "None")
 * onto devnet-shaped defaults (a local routing-peer URL/seller id, devnet
 * peer addresses, official-bootstrap disabled), silently mixing devnet
 * routing infra into what's otherwise a real-network session.
 *
 * When the preference is off (or unreadable/unset -- never default to on),
 * `opts` passes through unchanged: no router override, no routing-peer env,
 * `normalizeRouterIdentifier`'s own fallback takes it to the standard 'local'
 * price+trust router. When it's on, which routing peer and env this injects
 * further depends on the buyer's own configured chain
 * (`payments.crypto.chainId`, same config file): `base-local` gets the
 * devnet-shaped defaults (a local `local-peer-daemon.ts` instance, devnet
 * peer addresses, official-bootstrap disabled); anything else (real chains
 * default to `base-mainnet`, same as `createDefaultConfig()`) gets the real,
 * staked Levanto routing peer instead, with none of the devnet isolation
 * flags -- those would cut a real buyer off from the real dht1/dht2.antseed.com
 * swarm entirely.
 *
 * Applied here, at the single point every connect-mode `start()` call
 * ultimately funnels through (`ProcessManager.start` itself), rather than at
 * each individual caller -- there are at least two independent places that
 * start the connect runtime (a main-process auto-start on first chat message,
 * and a renderer-side auto-start on app boot that races ahead of it using its
 * own, unrelated router preference), and applying the override in only one of
 * them left the other silently winning the race with the wrong router. A
 * single choke point means neither caller needs to know this override exists.
 *
 * The dropdown itself now offers any installed router plugin, not just
 * Levanto (`buyer.routingPreferences.selectedRouterPackage`), but the
 * devnet/mainnet routing-peer env below is Levanto-specific operational
 * wiring this override was built to carry -- generalizing *that* would mean
 * knowing a given plugin's own configSchema values, which is out of scope
 * here. So: when a non-Levanto package is selected, this only sets
 * `opts.router` to that package (the CLI loads whatever plugin that names,
 * using its own config); the env injection and chain-dependent defaults
 * below apply only when router-levanto specifically is selected.
 */
/**
 * Reads `buyer.routingPreferences.autoSubscriptionEnabled` straight from disk
 * rather than caching it -- the config file is the one source of truth the
 * renderer's dropdown, a config-file edit, and this main-process check all
 * agree on, and a start() call is infrequent enough that a sync file read
 * here is not a real cost. Any read/parse failure (missing file, malformed
 * JSON, a config shape from before this field existed) resolves to false --
 * same "never default to on" rule as the real-money signing gate this
 * mirrors (router.ts's ensureSignedToday).
 */
function isLevantoAutoSubscriptionEnabled(): boolean {
  try {
    const raw = readFileSync(ACTIVE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as {
      buyer?: { routingPreferences?: { autoSubscriptionEnabled?: unknown } };
    };
    return parsed.buyer?.routingPreferences?.autoSubscriptionEnabled === true;
  } catch {
    return false;
  }
}

/**
 * router-levanto's own package name -- the historical, and still only,
 * router this override knows how to wire real operational defaults for
 * (routing-peer URL, seller peer id, devnet isolation flags below). A
 * different selected plugin still gets its package name passed through as
 * `opts.router` so the CLI loads it, but none of that Levanto-specific env
 * injection applies to it; see `applyLevantoRouterDemoOverride`.
 */
const LEVANTO_ROUTER_PACKAGE = '@antseed/router-levanto';

/**
 * Reads `buyer.routingPreferences.selectedRouterPackage` the same way
 * `isLevantoAutoSubscriptionEnabled` reads the toggle -- straight off disk,
 * no caching. Defaults to router-levanto on anything missing/unreadable/a
 * pre-migration config shape, matching preferences.ts's own migration
 * default so both independent readers of this same config field agree.
 */
function resolveSelectedRouterPackage(): string {
  try {
    const raw = readFileSync(ACTIVE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as {
      buyer?: { routingPreferences?: { selectedRouterPackage?: unknown } };
    };
    const pkg = parsed.buyer?.routingPreferences?.selectedRouterPackage;
    return typeof pkg === 'string' && pkg.trim().length > 0 ? pkg : LEVANTO_ROUTER_PACKAGE;
  } catch {
    return LEVANTO_ROUTER_PACKAGE;
  }
}

type RoutingPeerChainId = 'base-local' | 'base-sepolia' | 'base-mainnet';

/**
 * Reads the buyer's own configured chain the same way `isLevantoAutoSubscriptionEnabled`
 * reads the toggle -- straight off disk, no caching. Defaults to
 * `base-mainnet` on anything unreadable/unset, matching `createDefaultConfig()`'s
 * own default: real chains are this app's normal state, `base-local` is the
 * opt-in special case, not the other way around.
 */
function resolveConfiguredChainId(): RoutingPeerChainId {
  try {
    const raw = readFileSync(ACTIVE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as {
      payments?: { crypto?: { chainId?: unknown } };
    };
    const chainId = parsed.payments?.crypto?.chainId;
    if (chainId === 'base-local' || chainId === 'base-sepolia') return chainId;
    return 'base-mainnet';
  } catch {
    return 'base-mainnet';
  }
}

export function applyLevantoRouterDemoOverride(
  opts: StartOptions,
  isEnabled: () => boolean = isLevantoAutoSubscriptionEnabled,
  resolveChainId: () => RoutingPeerChainId = resolveConfiguredChainId,
  resolveRouterPackage: () => string = resolveSelectedRouterPackage,
): StartOptions {
  if (opts.mode !== 'connect') return opts;
  if (!isEnabled()) return opts;

  const selectedPackage = resolveRouterPackage();
  if (selectedPackage !== LEVANTO_ROUTER_PACKAGE) {
    return { ...opts, router: selectedPackage };
  }

  if (resolveChainId() === 'base-local') {
    return {
      ...opts,
      router: 'levanto',
      env: {
        ...opts.env,
        // Without this, router-levanto's RoutingLedger (routing_decisions,
        // savings-dashboard data) falls back to in-memory-only and is wiped
        // on every connect-mode subprocess restart -- this was a real
        // incident (a live 12-agent mainnet data run vanished on restart).
        LEVANTO_DATA_DIR: process.env['LEVANTO_DATA_DIR'] ?? join(resolveConnectDataDir(), 'router-levanto'),
        LEVANTO_ROUTING_PEER_URL: process.env['LEVANTO_ROUTING_PEER_URL'] ?? 'http://127.0.0.1:8787',
        LEVANTO_SELLER_PEER_ID: process.env['LEVANTO_SELLER_PEER_ID'] ?? 'c199453fd6b1c6823634ef9b3702eb5aeca71265',
        // Local-dev NAT-hairpinning escape hatch (runlog: "direct-peer-address
        // override"), not a production NAT solution -- see resolveDirectPeerAddresses
        // in apps/cli's buyer start command for what actually consumes this.
        ANTSEED_DIRECT_PEER_ADDRESSES_JSON: process.env['ANTSEED_DIRECT_PEER_ADDRESSES_JSON']
          ?? '{"c199453fd6b1c6823634ef9b3702eb5aeca71265":"127.0.0.1:6892","6306c9b78c84ad83365ff1e8c12eaa5f135fe1f2":"127.0.0.1:6894","c9f8839e97d2dfff1ac24e88830f0a58283d5b4c":"127.0.0.1:6896","447cecac64c36f8cf507109c464f1126c042a65b":"127.0.0.1:6898","54ba02b713327d36ea210deaacc20d464b9f3ccb":"127.0.0.1:6900","7a69b2ea13db7bbe63eef45627b13b98582a723a":"127.0.0.1:6902"}',
        // Isolates this demo buyer from the real public AntSeed network -- without
        // it, bootstrapping through the local-only routing peer still transitively
        // discovers real public sellers, since that peer is itself connected to
        // dht1/dht2.antseed.com. Local-dev only, same reasoning as the two vars above.
        ANTSEED_NO_OFFICIAL_BOOTSTRAP: process.env['ANTSEED_NO_OFFICIAL_BOOTSTRAP'] ?? '1',
      },
    };
  }

  // Real chain (base-mainnet / base-sepolia): point at the real, staked
  // Levanto routing peer instead, and skip the devnet isolation flags above
  // entirely -- ANTSEED_NO_OFFICIAL_BOOTSTRAP would cut this buyer off from
  // the real dht1/dht2.antseed.com swarm, and the direct-peer JSON names
  // devnet-only mock sellers that don't exist on a real chain.
  return {
    ...opts,
    router: 'levanto',
    env: {
      ...opts.env,
      LEVANTO_DATA_DIR: process.env['LEVANTO_DATA_DIR'] ?? join(resolveConnectDataDir(), 'router-levanto'),
      LEVANTO_ROUTING_PEER_URL: process.env['LEVANTO_ROUTING_PEER_URL'] ?? 'http://18.219.72.232:8787',
      LEVANTO_SELLER_PEER_ID: process.env['LEVANTO_SELLER_PEER_ID'] ?? '4c63288576d1befdbdd5f4734b4c9d4c3d8791be',
    },
  };
}

function resolveAlignedNodeFromMarker(): string | null {
  const markerCandidates = [
    resolve(process.cwd(), RUNTIME_NATIVE_MARKER_FILE),
    resolve(process.cwd(), 'desktop', RUNTIME_NATIVE_MARKER_FILE),
  ];

  for (const markerPath of markerCandidates) {
    if (!existsSync(markerPath)) {
      continue;
    }
    try {
      const raw = readFileSync(markerPath, 'utf8');
      const parsed = JSON.parse(raw) as { nodeExec?: unknown };
      const nodeExec = typeof parsed.nodeExec === 'string' ? parsed.nodeExec.trim() : '';
      if (nodeExec.length > 0 && existsSync(nodeExec)) {
        return nodeExec;
      }
    } catch {
      // Ignore malformed marker files and continue with normal candidate resolution.
    }
  }

  return null;
}

function resolveCliCommand(): string {
  const envCommand = process.env[CLI_COMMAND_ENV]?.trim();
  if (envCommand && envCommand.length > 0) {
    return envCommand;
  }

  const localCli = resolveLocalCliPath();
  if (existsSync(localCli)) {
    return localCli;
  }

  // Packaged app: CLI dist copied into Resources/cli-dist/ via extraResources
  if (typeof process.resourcesPath === 'string') {
    const bundledCli = join(process.resourcesPath, 'cli-dist', 'cli', 'index.js');
    if (existsSync(bundledCli)) {
      return bundledCli;
    }
  }

  return DEFAULT_CLI_COMMAND;
}

function resolveLocalCliPath(): string {
  const candidates = [
    // Desktop package cwd (apps/desktop).
    resolve(process.cwd(), ...LOCAL_CLI_BIN_RELATIVE),
    // Monorepo root cwd.
    resolve(process.cwd(), 'apps', 'cli', 'dist', 'cli', 'index.js'),
    // Sibling workspace package, located from the app root rather than cwd.
    resolve(WORKSPACE_APPS_DIR, 'cli', 'dist', 'cli', 'index.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

/**
 * Build NODE_PATH so that a child process spawned from the packaged app
 * can resolve modules from the unpacked node_modules directory.
 */
function resolveChildNodePath(): string {
  const paths: string[] = [];
  if (typeof process.resourcesPath === 'string') {
    // electron-builder unpacks node_modules here when asarUnpack includes them
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
    if (existsSync(unpacked)) {
      paths.push(unpacked);
    }
  }
  return paths.join(path.delimiter);
}

function detectNodeArch(nodeBinary: string): string | null {
  try {
    const output = execFileSync(nodeBinary, ['-p', 'process.arch'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      killSignal: 'SIGKILL',
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function detectNodeMajorVersion(nodeBinary: string): number | null {
  try {
    const output = execFileSync(nodeBinary, ['-p', 'process.versions.node.split(".")[0]'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      killSignal: 'SIGKILL',
    }).trim();
    const major = Number(output);
    return Number.isFinite(major) && major > 0 ? major : null;
  } catch {
    return null;
  }
}

type SemverTuple = [major: number, minor: number, patch: number];

function parseSemverTag(raw: string): SemverTuple | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverDesc(a: SemverTuple, b: SemverTuple): number {
  if (a[0] !== b[0]) return b[0] - a[0];
  if (a[1] !== b[1]) return b[1] - a[1];
  return b[2] - a[2];
}

function resolveNodeBinary(targetArch: string): string {
  // When packaged, prefer Electron's own Node.js runtime — its version matches
  // the bundled native modules (better-sqlite3, node-datachannel).  A system
  // node with a different major version would fail to load those modules.
  const isPackaged = typeof process.resourcesPath === 'string'
    && existsSync(join(process.resourcesPath, 'app.asar'));
  if (isPackaged) {
    return process.execPath;
  }

  const alignedNode = resolveAlignedNodeFromMarker();
  if (alignedNode) {
    return alignedNode;
  }

  const envNode = process.env[CLI_NODE_BIN_ENV]?.trim();
  const candidates: string[] = [];
  if (envNode) {
    candidates.push(envNode);
  }

  const nvmBin = process.env['NVM_BIN']?.trim();
  if (nvmBin) {
    candidates.push(join(nvmBin, 'node'));
  }

  const nvmVersionsDir = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmVersionsDir)) {
    try {
      const nvmVersions = readdirSync(nvmVersionsDir)
        .map((name) => ({ name, semver: parseSemverTag(name) }))
        .sort((left, right) => {
          if (left.semver && right.semver) {
            return compareSemverDesc(left.semver, right.semver);
          }
          if (left.semver) return -1;
          if (right.semver) return 1;
          return right.name.localeCompare(left.name);
        })
        .map((entry) => entry.name);
      for (const version of nvmVersions) {
        candidates.push(join(nvmVersionsDir, version, 'bin', 'node'));
      }
    } catch {
      // Ignore nvm lookup failures and continue with other candidates.
    }
  }

  candidates.push('/opt/homebrew/bin/node');
  candidates.push('/usr/local/bin/node');
  candidates.push('node');

  const tried = new Set<string>();
  let firstExisting: string | null = null;
  let firstCompatible: string | null = null;

  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) {
      continue;
    }
    tried.add(candidate);
    if (candidate !== 'node' && !existsSync(candidate)) {
      continue;
    }
    const majorVersion = detectNodeMajorVersion(candidate);
    if (majorVersion === null) {
      // Candidate doesn't exist or can't execute — skip it entirely.
      continue;
    }
    if (!firstExisting) {
      firstExisting = candidate;
    }
    const meetsMinVersion = majorVersion >= MIN_NODE_MAJOR_VERSION;
    if (meetsMinVersion) {
      if (!firstCompatible) {
        firstCompatible = candidate;
      }
      const arch = detectNodeArch(candidate);
      if (arch === targetArch) {
        return candidate;
      }
    }
  }

  return firstCompatible ?? firstExisting ?? process.execPath ?? 'node';
}

function resolveConfigPath(configPath?: string): string {
  if (!configPath || configPath.trim().length === 0) {
    return DEFAULT_CONFIG_PATH;
  }
  if (configPath.startsWith('~/')) {
    return join(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}

export function resolveConnectDataDir(): string {
  const envDir = process.env[CONNECT_DATA_DIR_ENV]?.trim();
  if (envDir && envDir.length > 0) {
    if (envDir.startsWith('~/')) {
      return join(homedir(), envDir.slice(2));
    }
    return resolve(envDir);
  }
  return DEFAULT_CONNECT_DATA_DIR;
}

type CliExecution = {
  executable: string;
  executableArgsPrefix: string[];
  // True only for the local monorepo dev script — native module alignment is
  // only needed there. The bundled production CLI already ships aligned natives.
  isLocalDevScript: boolean;
  cliCommand: string;
};

function resolveCliExecution(): CliExecution {
  const cliCommand = resolveCliCommand();
  const localCliPath = resolveLocalCliPath();
  const isLocalDevScript = existsSync(localCliPath) && resolve(cliCommand) === localCliPath;

  // The bundled CLI (from extraResources) is also a .js script that needs node.
  // Packaged macOS apps have a minimal PATH, so we must resolve node explicitly.
  const isBundledScript = !isLocalDevScript && cliCommand.endsWith('.js');
  const needsNode = isLocalDevScript || isBundledScript;

  const executable = needsNode ? resolveNodeBinary(process.arch) : cliCommand;
  const executableArgsPrefix = needsNode ? [cliCommand] : [];
  return {
    executable,
    executableArgsPrefix,
    isLocalDevScript,
    cliCommand,
  };
}

export function resolveCommandArgs(opts: StartOptions): string[] {
  const args: string[] = [];

  if (opts.verbose) {
    args.push('--verbose');
  }

  const configPath = resolveConfigPath(opts.configPath);
  args.push('--config', configPath);

  switch (opts.mode) {
    case 'connect':
      args.push('--data-dir', resolveConnectDataDir());
      args.push('buyer', 'start');
      {
        const router = normalizeRouterIdentifier(opts.router);
        if (router !== 'local') {
          args.push('--router', router);
        }
      }
      break;
    case 'system-proxy':
      args.push('--data-dir', desktopSystemProxyCliDataDir() ?? resolveConnectDataDir());
      args.push('system-proxy', 'start');
      if (opts.systemProxyPeerId) {
        args.push('--peer', opts.systemProxyPeerId);
      }
      if (opts.systemProxyPort) {
        args.push('--port', String(opts.systemProxyPort));
      }
      for (const profile of opts.systemProxyProfiles ?? []) {
        args.push('--profile', profile);
      }
      if (opts.systemProxyDefaultModel) {
        args.push('--default-model', opts.systemProxyDefaultModel);
      }
      for (const model of opts.systemProxyServedModels ?? []) {
        args.push('--served-model', model);
      }
      if (opts.setSystemProxy) {
        args.push('--system-proxy');
      }
      break;
    case 'tunnel':
      args.push('--data-dir', resolveConnectDataDir());
      args.push('tunnel', 'start');
      if (opts.tunnelBuyerPort) args.push('--buyer-port', String(opts.tunnelBuyerPort));
      break;
    default:
      throw new Error(`Unsupported runtime mode: ${String(opts.mode)}`);
  }

  return args;
}

export class ProcessManager {
  private readonly processes = new Map<RuntimeMode, ChildProcessWithoutNullStreams>();
  private readonly attachedModes = new Set<RuntimeMode>();
  private readonly startPromises = new Map<RuntimeMode, Promise<RuntimeProcessState>>();
  private runtimeNativeAligned = false;
  private runtimeNativeAlignmentPromise: Promise<void> | null = null;
  private readonly states = new Map<RuntimeMode, RuntimeProcessState>([
    ['connect', { mode: 'connect', running: false, pid: null, startedAt: null, lastExitCode: null, lastError: null }],
    ['system-proxy', { mode: 'system-proxy', running: false, pid: null, startedAt: null, lastExitCode: null, lastError: null }],
    ['tunnel', { mode: 'tunnel', running: false, pid: null, startedAt: null, lastExitCode: null, lastError: null }],
  ]);

  constructor(
    private readonly onLog: (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void,
  ) {}

  getState(): RuntimeProcessState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  attach(mode: RuntimeMode): RuntimeProcessState {
    const state = this.states.get(mode)!;
    this.attachedModes.add(mode);
    state.running = true;
    state.pid = null;
    state.startedAt = Date.now();
    state.lastExitCode = null;
    state.lastError = null;
    this.onLog(mode, 'system', `Attached to existing ${mode} runtime`);
    return { ...state };
  }

  isAttached(mode: RuntimeMode): boolean {
    return this.attachedModes.has(mode);
  }

  detach(mode: RuntimeMode, reason: string): RuntimeProcessState {
    const state = this.states.get(mode)!;
    if (!this.attachedModes.delete(mode)) {
      return { ...state };
    }
    state.running = false;
    state.pid = null;
    state.lastError = reason;
    this.onLog(mode, 'system', reason);
    return { ...state };
  }

  getDaemonStateSnapshot(): DaemonStateSnapshot {
    const stateFile = join(homedir(), '.antseed', 'daemon.state.json');
    if (!existsSync(stateFile)) {
      return { exists: false, state: null };
    }
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
      return { exists: true, state: parsed };
    } catch {
      return { exists: true, state: null };
    }
  }

  async start(rawOpts: StartOptions): Promise<RuntimeProcessState> {
    const opts = applyLevantoRouterDemoOverride(rawOpts);
    const mode = opts.mode;
    if (this.processes.has(mode)) {
      throw new Error(`${mode} is already running`);
    }
    const inFlightStart = this.startPromises.get(mode);
    if (inFlightStart) {
      return inFlightStart;
    }

    const startPromise = this.spawnForMode(mode, opts).finally(() => {
      this.startPromises.delete(mode);
    });
    this.startPromises.set(mode, startPromise);
    return startPromise;
  }

  private async spawnForMode(mode: RuntimeMode, opts: StartOptions): Promise<RuntimeProcessState> {
    this.attachedModes.delete(mode);

    const cliExecution = resolveCliExecution();
    const args = resolveCommandArgs(opts);
    const executable = cliExecution.executable;
    const executableArgs = [...cliExecution.executableArgsPrefix, ...args];
    await this.ensureRuntimeNativeModules(mode, executable, cliExecution.isLocalDevScript);
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // Desktop repairs the default router from its own app bundle. Do not let
    // the child CLI try an npm-based plugin refresh/install on locked-down
    // machines where npm may be unavailable or behind corporate TLS proxies.
    childEnv['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'] = '1';
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      if (typeof key === 'string' && key.trim().length > 0) {
        childEnv[key] = String(value);
      }
    }
    // When using Electron's own binary as node, set ELECTRON_RUN_AS_NODE so it
    // behaves like a regular Node.js process. Otherwise, remove it.
    if (executable === process.execPath) {
      childEnv['ELECTRON_RUN_AS_NODE'] = '1';
    } else {
      delete childEnv['ELECTRON_RUN_AS_NODE'];
    }
    const extraNodePath = resolveChildNodePath();
    if (extraNodePath) {
      childEnv['NODE_PATH'] = extraNodePath + (childEnv['NODE_PATH'] ? `${path.delimiter}${childEnv['NODE_PATH']}` : '');
    }

    const child = spawn(executable, executableArgs, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: 'pipe',
    });

    this.processes.set(mode, child);

    const state = this.states.get(mode)!;
    state.running = true;
    state.pid = child.pid ?? null;
    state.startedAt = Date.now();
    state.lastError = null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          this.onLog(mode, 'stdout', line);
        }
      }
    });

    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          this.onLog(mode, 'stderr', line);
        }
      }
    });

    child.on('error', (err) => {
      state.lastError = err.message;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        state.running = false;
        state.pid = null;
        this.processes.delete(mode);
        this.onLog(
          mode,
          'system',
          `CLI command "${cliExecution.cliCommand}" was not found (executable: "${executable}"). Install Node.js ≥${MIN_NODE_MAJOR_VERSION} or set ${CLI_COMMAND_ENV} to a valid executable path.`,
        );
        return;
      }
      this.onLog(mode, 'system', `Process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (this.processes.get(mode) === child) {
        this.processes.delete(mode);
        state.running = false;
        state.pid = null;
        state.lastExitCode = code;
      }
      const reason = signal ? `signal=${signal}` : `code=${String(code)}`;
      this.onLog(mode, 'system', `Process exited (${reason})`);
    });

    this.onLog(
      mode,
      'system',
      `Started ${mode} with "${executable}" (pid=${String(child.pid ?? 'unknown')})`,
    );
    if (mode === 'connect') {
      const dataDir = resolveConnectDataDir();
      this.onLog(mode, 'system', `Connect data dir: ${dataDir}`);
      if (dataDir === DEFAULT_CONNECT_DATA_DIR && existsSync(LEGACY_DESKTOP_CONNECT_DATA_DIR)) {
        this.onLog(
          mode,
          'system',
          `Legacy desktop connect data dir detected at ${LEGACY_DESKTOP_CONNECT_DATA_DIR}. Set ${CONNECT_DATA_DIR_ENV} to use it explicitly.`,
        );
      }
    }
    return { ...state };
  }

  async runCliCommand(args: string[], mode: RuntimeMode = 'connect'): Promise<CliCommandResult> {
    const cliExecution = resolveCliExecution();
    const executable = cliExecution.executable;
    const executableArgs = [...cliExecution.executableArgsPrefix, ...args];

    const childEnv = { ...process.env };
    childEnv['ANTSEED_SKIP_PLUGIN_UPDATE_CHECK'] = '1';
    if (executable === process.execPath) {
      childEnv['ELECTRON_RUN_AS_NODE'] = '1';
    } else {
      delete childEnv['ELECTRON_RUN_AS_NODE'];
    }
    const extraNodePath = resolveChildNodePath();
    if (extraNodePath) {
      childEnv['NODE_PATH'] = extraNodePath + (childEnv['NODE_PATH'] ? `${path.delimiter}${childEnv['NODE_PATH']}` : '');
    }

    this.onLog(mode, 'system', `Running command: ${executableArgs.join(' ')}`);

    return await new Promise<CliCommandResult>((resolveCommand, rejectCommand) => {
      const child = spawn(executable, executableArgs, {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutTail = '';
      let stderrTail = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        stdoutTail += chunk;
        const lines = stdoutTail.split(/\r?\n/);
        stdoutTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        stderrTail += chunk;
        const lines = stderrTail.split(/\r?\n/);
        stderrTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          rejectCommand(
            new Error(
              `CLI command "${cliExecution.cliCommand}" was not found. Install antseed on PATH or set ${CLI_COMMAND_ENV} to a valid executable path.`,
            ),
          );
          return;
        }
        rejectCommand(new Error(`CLI command failed to start: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        if (stdoutTail.trim().length > 0) {
          this.onLog(mode, 'system', stdoutTail.trim());
        }
        if (stderrTail.trim().length > 0) {
          this.onLog(mode, 'system', stderrTail.trim());
        }

        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          const reason = signal ? `signal=${signal}` : `code=${String(exitCode)}`;
          const detail = stderr.trim() || stdout.trim();
          rejectCommand(
            new Error(
              detail.length > 0
                ? `Command failed (${reason}): ${detail}`
                : `Command failed (${reason})`,
            ),
          );
          return;
        }

        resolveCommand({ code: exitCode, stdout, stderr });
      });
    });
  }

  private async ensureRuntimeNativeModules(mode: RuntimeMode, executable: string, isLocalDevScript: boolean): Promise<void> {
    if (!isLocalDevScript) {
      return;
    }
    if (this.runtimeNativeAligned) {
      return;
    }
    if (this.runtimeNativeAlignmentPromise) {
      await this.runtimeNativeAlignmentPromise;
      return;
    }

    const scriptPath = resolve(process.cwd(), ...RUNTIME_NATIVE_SCRIPT_RELATIVE);
    if (!existsSync(scriptPath)) {
      this.onLog(mode, 'system', 'Native module preflight script not found; skipping runtime alignment.');
      return;
    }

    this.runtimeNativeAlignmentPromise = this.runRuntimeNativeAlignment(mode, executable, scriptPath)
      .then(() => {
        this.runtimeNativeAligned = true;
      })
      .catch((err) => {
        this.runtimeNativeAlignmentPromise = null;
        throw err;
      });

    await this.runtimeNativeAlignmentPromise;
  }

  private async runRuntimeNativeAlignment(mode: RuntimeMode, executable: string, scriptPath: string): Promise<void> {
    const childEnv = { ...process.env };
    delete childEnv['ELECTRON_RUN_AS_NODE'];

    await new Promise<void>((resolveAlignment, rejectAlignment) => {
      const child = spawn(executable, [scriptPath], {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutTail = '';
      let stderrTail = '';
      let stderrCapture = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdoutTail += chunk;
        const lines = stdoutTail.split(/\r?\n/);
        stdoutTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.stderr.on('data', (chunk: string) => {
        stderrTail += chunk;
        stderrCapture += chunk;
        const lines = stderrTail.split(/\r?\n/);
        stderrTail = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.onLog(mode, 'system', line);
          }
        }
      });

      child.on('error', (err) => {
        rejectAlignment(new Error(`Native module alignment failed: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        if (stdoutTail.trim().length > 0) {
          this.onLog(mode, 'system', stdoutTail.trim());
        }
        if (stderrTail.trim().length > 0) {
          this.onLog(mode, 'system', stderrTail.trim());
        }

        if (code === 0) {
          resolveAlignment();
          return;
        }

        const reason = signal ? `signal=${signal}` : `code=${String(code)}`;
        const detail = stderrCapture.trim();
        rejectAlignment(
          new Error(
            detail.length > 0
              ? `Native module alignment failed (${reason}): ${detail}`
              : `Native module alignment failed (${reason})`,
          ),
        );
      });
    });
  }

  async stop(mode: RuntimeMode, preserve = false): Promise<RuntimeProcessState> {
    const child = this.processes.get(mode);
    const state = this.states.get(mode)!;
    this.attachedModes.delete(mode);

    if (!child || preserve) {
      if (child) {
        this.processes.delete(mode);
        child.unref();
      }
      state.running = false;
      state.pid = null;
      return { ...state };
    }

    await new Promise<void>((resolveStop) => {
      let resolved = false;
      const finish = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(forceKillTimeout);
        clearTimeout(resolveTimeout);
        resolveStop();
      };

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5_000);
      const forceKillTimeout = timeout;
      const resolveTimeout = setTimeout(() => {
        this.processes.delete(mode);
        state.running = false;
        state.pid = null;
        finish();
      }, 7_500);

      child.once('exit', finish);

      child.kill('SIGTERM');
    });

    return { ...state };
  }

  async stopAll(): Promise<void> {
    await Promise.all([
      this.stop('system-proxy'),
      this.stop('connect'),
      this.stop('tunnel'),
    ]);
  }
}
