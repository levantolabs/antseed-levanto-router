import {
  Contract,
  FallbackProvider,
  FetchRequest,
  JsonRpcProvider,
  Network,
  type AbstractProvider,
  type AbstractSigner,
  type InterfaceAbi,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';

const FALLBACK_STALL_TIMEOUT_MS = 750;
const JSON_RPC_REQUEST_TIMEOUT_MS = 2_500;
/**
 * ethers' default JsonRpcProvider pollingInterval is 4000ms -- fine for a
 * real remote chain, but on a local anvil instance (which mines instantly)
 * that means every tx.wait() takes up to a full 4s even though the
 * transaction already has a real receipt. Confirmed live while seeding the
 * mock marketplace: a seller wallet's on-chain nonce was observed advancing
 * in real time while tx.wait() calls sat "stuck" for exactly this long --
 * not a hang, just an unnecessarily slow poll cadence. Scoped to
 * loopback URLs only so this never touches polling behavior (or request
 * volume/cost) against a real remote RPC endpoint.
 */
const LOCAL_RPC_POLLING_INTERVAL_MS = 100;

function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function createJsonRpcProvider(url: string, network?: Network, opts?: object): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = JSON_RPC_REQUEST_TIMEOUT_MS;
  const provider = new JsonRpcProvider(request, network, opts);
  if (isLoopbackUrl(url)) {
    provider.pollingInterval = LOCAL_RPC_POLLING_INTERVAL_MS;
  }
  return provider;
}

/**
 * Builds the ensemble provider AND keeps the individual per-URL providers
 * around (`raw`) so `_readWithFallback` has a manual, explicit backstop that
 * doesn't depend on FallbackProvider's own internal failover heuristics --
 * see `_readWithFallback`'s doc comment for why that backstop exists.
 */
function buildProvider(rpcUrl: string, fallbackRpcUrls?: string[], evmChainId?: number): { provider: AbstractProvider; raw: AbstractProvider[] } {
  const network = evmChainId ? Network.from(evmChainId) : undefined;
  const opts = { batchMaxCount: 1, staticNetwork: network ? true : undefined };
  const urls = [rpcUrl, ...(fallbackRpcUrls ?? [])];
  const raw = urls.map((url) => createJsonRpcProvider(url, network, opts));
  if (raw.length === 1) {
    return { provider: raw[0]!, raw };
  }
  const configs = raw.map((provider, i) => ({
    provider,
    priority: i + 1,
    stallTimeout: FALLBACK_STALL_TIMEOUT_MS,
    weight: 1,
  }));
  return { provider: new FallbackProvider(configs, network, { quorum: 1 }), raw };
}

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
] as const;

/** Gas limit buffer multiplier over `eth_estimateGas` (30%). Protects against
 *  non-deterministic gas in contract branches (cold vs. warm SSTOREs, try/catch
 *  fallback paths, variable-length metadata hashing) — without a buffer, a tx
 *  whose actual gas is even a hair above the estimate reverts with OOG. */
const GAS_BUFFER_NUMERATOR = 130n;
const GAS_BUFFER_DENOMINATOR = 100n;

export abstract class BaseEvmClient {
  protected readonly _provider: AbstractProvider;
  protected readonly _contractAddress: string;
  protected readonly _nonceCursor = new Map<string, number>();
  private readonly _nonceLocks = new Map<string, Promise<void>>();
  private readonly _rawProviders: AbstractProvider[];

  constructor(rpcUrl: string, contractAddress: string, fallbackRpcUrls?: string[], evmChainId?: number) {
    const built = buildProvider(rpcUrl, fallbackRpcUrls, evmChainId);
    this._provider = built.provider;
    this._rawProviders = built.raw;
    this._contractAddress = contractAddress;
  }

  get provider(): AbstractProvider { return this._provider; }
  get contractAddress(): string { return this._contractAddress; }

  /**
   * Explicit, manual fallback for reads that must not silently proceed
   * unverified -- a real incident (BuyerPaymentManager.topUpReserve) showed
   * `this._provider`'s FallbackProvider ensemble not engaging a healthy
   * configured fallback (base.drpc.org) while the primary (Tenderly) was
   * returning sustained 503s: seven confirmed 503s in the runtime logs, zero
   * uses of the fallback URL, while the fallback was independently confirmed
   * healthy and faster. The exact ethers-internal reason FallbackProvider
   * didn't broaden to the next priority backend for this failure class
   * hasn't been root-caused -- rather than tune undocumented FallbackProvider
   * heuristics blind, this adds a provably-correct manual backstop: try the
   * ensemble first (unchanged, still the fast path for ordinary transient
   * blips), and on failure, retry sequentially and directly against each
   * individually-held per-URL provider before giving up. Use this for any
   * read a caller must be able to trust failed only after every configured
   * RPC was tried, not just the (evidently sometimes silent) ensemble.
   */
  protected async _readWithFallback<T>(perform: (provider: AbstractProvider) => Promise<T>): Promise<T> {
    try {
      return await perform(this._provider);
    } catch (primaryErr) {
      if (this._rawProviders.length <= 1) throw primaryErr;
      let lastErr: unknown = primaryErr;
      for (const provider of this._rawProviders) {
        try {
          return await perform(provider);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    }
  }

  protected _ensureConnected(signer: AbstractSigner): AbstractSigner {
    if (signer.provider) return signer;
    return signer.connect(this._provider);
  }

  protected async _execWrite(
    signer: AbstractSigner,
    abi: InterfaceAbi,
    method: string,
    ...args: unknown[]
  ): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, abi, connected);
    const populated = await contract.getFunction(method).populateTransaction(...args);
    const tx = await this._sendBuffered(connected, signerAddress, populated);
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  /**
   * Approve USDC spending then execute a contract method.
   */
  protected async _approveAndExec(
    signer: AbstractSigner,
    usdcAddress: string,
    amount: bigint,
    abi: InterfaceAbi,
    method: string,
    ...args: unknown[]
  ): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const usdc = new Contract(usdcAddress, ERC20_ABI, connected);
    const approvePopulated = await usdc.getFunction('approve').populateTransaction(this._contractAddress, amount);
    const approveTx = await this._sendBuffered(connected, signerAddress, approvePopulated);
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error('Approve transaction was dropped or replaced');
    return this._execWrite(signer, abi, method, ...args);
  }

  /**
   * Reserve a nonce, apply the gas buffer, and broadcast. On any failure —
   * estimateGas revert, RPC timeout, submission error — roll back the nonce
   * cursor. `_reserveNonce` reads `getTransactionCount(..., 'pending')` on
   * the next call, so an in-flight tx (if sendTransaction failed after the
   * node accepted it) is still accounted for and we won't reuse its nonce.
   */
  private async _sendBuffered(
    connected: AbstractSigner,
    signerAddress: string,
    populated: TransactionRequest,
  ): Promise<TransactionResponse> {
    const nonce = await this._reserveNonce(signerAddress);
    populated.nonce = nonce;
    try {
      const estimated = await connected.estimateGas(populated);
      populated.gasLimit = (estimated * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
      return await connected.sendTransaction(populated);
    } catch (err) {
      this._nonceCursor.delete(signerAddress);
      throw err;
    }
  }

  protected async _reserveNonce(address: string): Promise<number> {
    // Serialize nonce reservation per address to prevent concurrent calls
    // from reading the same network nonce before either updates the cursor
    const prev = this._nonceLocks.get(address) ?? Promise.resolve();
    let resolve: () => void;
    const lock = new Promise<void>(r => { resolve = r; });
    this._nonceLocks.set(address, lock);

    await prev;
    try {
      const networkNonce = await this._provider.getTransactionCount(address, 'pending');
      const cachedNext = this._nonceCursor.get(address);
      const nonce = cachedNext === undefined ? networkNonce : Math.max(networkNonce, cachedNext);
      this._nonceCursor.set(address, nonce + 1);
      return nonce;
    } finally {
      resolve!();
    }
  }
}
