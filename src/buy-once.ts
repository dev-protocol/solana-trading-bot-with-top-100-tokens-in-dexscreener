import dotenv from 'dotenv';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

dotenv.config();

const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://lite-api.jup.ag/swap/v1/swap';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

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

async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number
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
  console.log(`📊 Fetching quote from: ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get quote: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const quote = await response.json() as JupiterQuoteResponse;
  return quote;
}

async function getSwapTransaction(
  quoteResponse: JupiterQuoteResponse,
  userPublicKey: PublicKey,
  priorityFeeLamports?: number
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

  console.log(`🔄 Requesting swap transaction...`);

  const response = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(swapRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get swap transaction: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const swapResponse = await response.json() as JupiterSwapResponse;
  return swapResponse;
}

function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  return BigInt(10) ** BigInt(decimals);
}

function parsePositiveIntEnv(name: string): number {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing required env var: ${name}`);
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive integer. Got: ${raw}`);
  }
  return n;
}

function formatLamportsAsSol(lamports: bigint): string {
  const sign = lamports < BigInt(0) ? '-' : '';
  const abs = lamports < BigInt(0) ? -lamports : lamports;
  const whole = abs / BigInt(1_000_000_000);
  const frac = (abs % BigInt(1_000_000_000)).toString().padStart(9, '0');
  return `${sign}${whole.toString()}.${frac}`;
}

async function buyFixedTokensOnce(): Promise<void> {
  try {
    const quoteTokenAddress = process.env.QUOTE_TOKEN_ADDRESS;
    const privateKeyBase58 = process.env.PRIVATE_KEY;
    const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '50', 10);
    const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

    if (!quoteTokenAddress || !privateKeyBase58) {
      throw new Error('Missing QUOTE_TOKEN_ADDRESS or PRIVATE_KEY in .env');
    }

    const quoteMint = new PublicKey(quoteTokenAddress);
    const tokenDecimals = parsePositiveIntEnv('QUOTE_TOKEN_DECIMALS');
    const buyTokenAmountWhole = parsePositiveIntEnv('BUY_TOKEN_AMOUNT'); // whole tokens
    const priorityFeeLamports = Number(process.env.PRIORITY_FEE_LAMPORTS || '1000000');

    const desiredTokenUnits = BigInt(buyTokenAmountWhole) * pow10(tokenDecimals);

    // Parse private key
    let keypair: Keypair;
    try {
      const privateKeyBytes = bs58.decode(privateKeyBase58);
      keypair = Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
      throw new Error(`Invalid private key format. Expected base58 encoded string. Error: ${error}`);
    }

    const connection = new Connection(rpcUrl, 'confirmed');

    console.log('🚀 Single BUY: Fixed token amount');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📍 Wallet: ${keypair.publicKey.toString()}`);
    console.log(`🪙 Token (QUOTE): ${quoteMint.toString()}`);
    console.log(`🎯 Target amount: ${buyTokenAmountWhole} tokens (units: ${desiredTokenUnits.toString()})`);
    console.log(`📉 Slippage: ${slippageBps} bps (${(slippageBps / 100).toFixed(2)}%)`);
    console.log(`🌐 RPC: ${rpcUrl}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Step 1: Get a price estimate using a small SOL amount (from IN_AMOUNT or 0.01 SOL)
    const probeInLamportsEnv = process.env.IN_AMOUNT;
    const probeInLamports = probeInLamportsEnv ? BigInt(probeInLamportsEnv) : BigInt(10_000_000); // 0.01 SOL

    const solBalance = BigInt(await connection.getBalance(keypair.publicKey, 'confirmed'));
    if (solBalance < probeInLamports) {
      throw new Error(
        `Insufficient SOL for probe quote. Have ${formatLamportsAsSol(solBalance)} SOL, need at least ${formatLamportsAsSol(
          probeInLamports
        )} SOL`
      );
    }

    const probeQuote = await getQuote(
      WSOL_MINT,
      quoteMint.toString(),
      probeInLamports.toString(),
      slippageBps
    );

    const probeOutUnits = BigInt(probeQuote.outAmount);
    if (probeOutUnits <= BigInt(0)) {
      throw new Error('Probe quote returned zero output amount');
    }

    // Approximate required SOL:
    // desiredUnits / probeOutUnits ≈ requiredSOL / probeInLamports
    const requiredSolLamportsApprox =
      (desiredTokenUnits * BigInt(probeQuote.inAmount)) / probeOutUnits;

    if (requiredSolLamportsApprox <= BigInt(0)) {
      throw new Error('Computed required SOL is zero or negative');
    }

    if (solBalance < requiredSolLamportsApprox) {
      throw new Error(
        `Insufficient SOL to buy ~${buyTokenAmountWhole} tokens. Need about ${formatLamportsAsSol(
          requiredSolLamportsApprox
        )} SOL, have ${formatLamportsAsSol(solBalance)} SOL`
      );
    }

    console.log(
      `💡 Estimated required SOL: ${formatLamportsAsSol(requiredSolLamportsApprox)} SOL (lamports: ${requiredSolLamportsApprox.toString()})`
    );

    // Step 2: Get final quote with estimated required SOL and execute swap (no extra price limits)
    const finalQuote = await getQuote(
      WSOL_MINT,
      quoteMint.toString(),
      requiredSolLamportsApprox.toString(),
      slippageBps
    );

    console.log('✅ Final quote:');
    console.log(`   Input SOL (lamports): ${finalQuote.inAmount}`);
    console.log(`   Output tokens (units): ${finalQuote.outAmount}`);
    console.log(`   Price impact: ${finalQuote.priceImpactPct}%`);

    const swapResponse = await getSwapTransaction(
      finalQuote,
      keypair.publicKey,
      priorityFeeLamports
    );

    const txBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const serialized = tx.serialize();
    const signature = await connection.sendRawTransaction(serialized, {
      skipPreflight: false,
      maxRetries: 3,
    });

    console.log(`✅ BUY transaction sent!`);
    console.log(`📝 Signature: ${signature}`);
    console.log(`🔗 Explorer: https://solscan.io/tx/${signature}`);

    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed'
    );

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log('🎉 BUY completed successfully!');
    console.log(`   Target tokens: ${buyTokenAmountWhole}`);
    console.log(`   Quoted tokens: ${finalQuote.outAmount}`);
  } catch (error: any) {
    console.error('\n❌ Error in BUY:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

buyFixedTokensOnce();

