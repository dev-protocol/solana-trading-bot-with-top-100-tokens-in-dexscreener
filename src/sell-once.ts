import dotenv from 'dotenv';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import bs58 from 'bs58';

dotenv.config();

const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
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

async function getTokenAccountBalanceForMint(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey
): Promise<{ balance: bigint; tokenProgramId: PublicKey; tokenAccount: PublicKey } | null> {
  // Try standard Token Program first
  let ata = await getAssociatedTokenAddress(
    mint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  try {
    const account = await getAccount(connection, ata, 'confirmed');
    return {
      balance: BigInt(account.amount.toString()),
      tokenProgramId: TOKEN_PROGRAM_ID,
      tokenAccount: ata,
    };
  } catch {
    // Try Token-2022 ATA
    ata = await getAssociatedTokenAddress(
      mint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const accountInfo = await connection.getAccountInfo(ata, 'confirmed');
    if (!accountInfo || !accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return null;
    }

    if (accountInfo.data.length < 72) {
      return null;
    }
    const amountBytes = Buffer.from(accountInfo.data.slice(64, 72));
    const balance = amountBytes.readBigUInt64LE(0);
    return {
      balance,
      tokenProgramId: TOKEN_2022_PROGRAM_ID,
      tokenAccount: ata,
    };
  }
}

function formatLamportsAsSol(lamports: bigint): string {
  const sign = lamports < BigInt(0) ? '-' : '';
  const abs = lamports < BigInt(0) ? -lamports : lamports;
  const whole = abs / BigInt(1_000_000_000);
  const frac = (abs % BigInt(1_000_000_000)).toString().padStart(9, '0');
  return `${sign}${whole.toString()}.${frac}`;
}

async function sellAllConfiguredTokenOnce(): Promise<void> {
  try {
    const quoteTokenAddress = process.env.QUOTE_TOKEN_ADDRESS;
    const privateKeyBase58 = process.env.PRIVATE_KEY;
    const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '50', 10);
    const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const priorityFeeLamports = Number(process.env.PRIORITY_FEE_LAMPORTS || '1000000');

    if (!quoteTokenAddress || !privateKeyBase58) {
      throw new Error('Missing QUOTE_TOKEN_ADDRESS or PRIVATE_KEY in .env');
    }

    const quoteMint = new PublicKey(quoteTokenAddress);

    // Parse private key
    let keypair: Keypair;
    try {
      const privateKeyBytes = bs58.decode(privateKeyBase58);
      keypair = Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
      throw new Error(`Invalid private key format. Expected base58 encoded string. Error: ${error}`);
    }

    const connection = new Connection(rpcUrl, 'confirmed');

    console.log('🚀 Single SELL: All configured token -> SOL');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📍 Wallet: ${keypair.publicKey.toString()}`);
    console.log(`🪙 Token (QUOTE): ${quoteMint.toString()}`);
    console.log(`📉 Slippage: ${slippageBps} bps (${(slippageBps / 100).toFixed(2)}%)`);
    console.log(`🌐 RPC: ${rpcUrl}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const tokenInfo = await getTokenAccountBalanceForMint(
      connection,
      quoteMint,
      keypair.publicKey
    );

    if (!tokenInfo || tokenInfo.balance <= BigInt(0)) {
      console.log('✅ No balance found for configured token. Nothing to sell.');
      return;
    }

    console.log(`💰 Token balance (units): ${tokenInfo.balance.toString()}`);

    const solBefore = BigInt(await connection.getBalance(keypair.publicKey, 'confirmed'));
    console.log(`💰 SOL balance before: ${formatLamportsAsSol(solBefore)} SOL`);

    // Step 1: Get quote to sell all tokens to SOL
    const quoteResponse = await getQuote(
      quoteMint.toString(),
      WSOL_MINT,
      tokenInfo.balance.toString(),
      slippageBps
    );

    console.log('✅ Quote received:');
    console.log(`   Input tokens (units): ${quoteResponse.inAmount}`);
    console.log(`   Output SOL (lamports): ${quoteResponse.outAmount}`);
    console.log(`   Price impact: ${quoteResponse.priceImpactPct}%`);

    // Step 2: Swap transaction
    const swapResponse = await getSwapTransaction(
      quoteResponse,
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

    console.log(`✅ SELL transaction sent!`);
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

    // Wait longer for account state to update after swap
    console.log('⏳ Waiting for account state to update...');
    await new Promise(resolve => setTimeout(resolve, 5000)); // Increased to 5 seconds
    
    const solAfter = BigInt(await connection.getBalance(keypair.publicKey, 'confirmed'));
    const solDelta = solAfter - solBefore;

    console.log(`💰 SOL balance after: ${formatLamportsAsSol(solAfter)} SOL`);
    console.log(`💰 SOL received: ${formatLamportsAsSol(solDelta)} SOL`);

    // Attempt to close token ATA if empty (optional cleanup)
    console.log('🗑️  Attempting to close token account if empty...');
    try {
      const { tokenAccount, tokenProgramId } = tokenInfo;

      // Re-check balance right before closing (with retry)
      let currentBalance = BigInt(0);
      let shouldClose = false;
      
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          console.log(`   ⏳ Re-checking balance (attempt ${attempt + 1}/3)...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (tokenProgramId.equals(TOKEN_PROGRAM_ID)) {
          try {
            const acc = await getAccount(connection, tokenAccount, 'confirmed');
            currentBalance = BigInt(acc.amount.toString());
            console.log(`   📊 Token account balance: ${currentBalance.toString()} units`);
            if (currentBalance === BigInt(0)) {
              shouldClose = true;
              break;
            }
          } catch (e: any) {
            // Account might not exist or already closed
            console.log(`   ℹ️  Token account not found or already closed`);
            shouldClose = false;
            break;
          }
        } else {
          // Token-2022
          const info = await connection.getAccountInfo(tokenAccount, 'confirmed');
          if (!info) {
            console.log(`   ℹ️  Token account not found or already closed`);
            shouldClose = false;
            break;
          }
          if (info.data.length >= 72) {
            const amountBytes = Buffer.from(info.data.slice(64, 72));
            currentBalance = amountBytes.readBigUInt64LE(0);
            console.log(`   📊 Token account balance: ${currentBalance.toString()} units`);
            if (currentBalance === BigInt(0)) {
              shouldClose = true;
              break;
            }
          }
        }
      }

      if (shouldClose && currentBalance === BigInt(0)) {
        console.log(`   ✅ Token account is empty, closing...`);
        const closeIx = createCloseAccountInstruction(
          tokenAccount,
          keypair.publicKey,
          keypair.publicKey,
          [],
          tokenProgramId
        );
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const closeTx = new (require('@solana/web3.js').Transaction)().add(closeIx);
        closeTx.recentBlockhash = blockhash;
        closeTx.feePayer = keypair.publicKey;
        closeTx.sign(keypair);

        const closeSig = await connection.sendRawTransaction(closeTx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        console.log(`   ✅ Close token account tx sent: ${closeSig}`);
        console.log(`   🔗 Explorer: https://solscan.io/tx/${closeSig}`);
        
        // Confirm close transaction
        const closeConfirmation = await connection.confirmTransaction(closeSig, 'confirmed');
        if (closeConfirmation.value.err) {
          console.log(`   ⚠️  Close transaction failed: ${JSON.stringify(closeConfirmation.value.err)}`);
        } else {
          console.log(`   ✅ Token account closed successfully!`);
        }
      } else if (currentBalance > BigInt(0)) {
        console.log(`   ⏭️  Token account still has balance: ${currentBalance.toString()} units, cannot close.`);
        console.log(`   💡 This might be due to rounding or slippage. You may need to sell the remaining balance manually.`);
      } else {
        console.log('⏭️  Token account not found or already closed, skip close.');
      }
    } catch (e: any) {
      console.log(`⚠️  Failed to close token account (non-fatal): ${e.message}`);
      if (e.logs) {
        console.log(`   📋 Transaction logs:`, e.logs);
      }
    }

    console.log('🎉 SELL completed successfully!');
  } catch (error: any) {
    console.error('\n❌ Error in SELL:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

sellAllConfiguredTokenOnce();

