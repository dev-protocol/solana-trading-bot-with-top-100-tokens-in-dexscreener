import dotenv from 'dotenv';
import { Connection, Keypair, VersionedTransaction, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import bs58 from 'bs58';

// Load environment variables
dotenv.config();

// Token-2022 Program ID
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Jupiter API endpoints
const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://lite-api.jup.ag/swap/v1/swap';

// WSOL (Wrapped SOL) mint address
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

// Helper function to get all token accounts from a wallet
async function getAllTokenAccounts(
  connection: Connection,
  ownerPublicKey: PublicKey
): Promise<Array<{ mint: string; balance: bigint; tokenProgramId: PublicKey; tokenAccount: PublicKey }>> {
  const tokenAccounts: Array<{ mint: string; balance: bigint; tokenProgramId: PublicKey; tokenAccount: PublicKey }> = [];

  try {
    // Get Token Program accounts
    const tokenProgramAccounts = await connection.getParsedTokenAccountsByOwner(
      ownerPublicKey,
      { programId: TOKEN_PROGRAM_ID },
      'confirmed'
    );

    for (const accountInfo of tokenProgramAccounts.value) {
      const parsedInfo = accountInfo.account.data.parsed.info;
      const mint = parsedInfo.mint;
      const balance = BigInt(parsedInfo.tokenAmount.amount);
      
      if (balance > BigInt(0) && mint !== WSOL_MINT) {
        tokenAccounts.push({
          mint,
          balance,
          tokenProgramId: TOKEN_PROGRAM_ID,
          tokenAccount: new PublicKey(accountInfo.pubkey),
        });
      }
    }

    // Get Token-2022 accounts
    const token2022Accounts = await connection.getParsedTokenAccountsByOwner(
      ownerPublicKey,
      { programId: TOKEN_2022_PROGRAM_ID },
      'confirmed'
    );

    for (const accountInfo of token2022Accounts.value) {
      const parsedInfo = accountInfo.account.data.parsed.info;
      const mint = parsedInfo.mint;
      const balance = BigInt(parsedInfo.tokenAmount.amount);
      
      if (balance > BigInt(0) && mint !== WSOL_MINT) {
        tokenAccounts.push({
          mint,
          balance,
          tokenProgramId: TOKEN_2022_PROGRAM_ID,
          tokenAccount: new PublicKey(accountInfo.pubkey),
        });
      }
    }
  } catch (error: any) {
    console.error(`Error fetching token accounts: ${error.message}`);
  }

  return tokenAccounts;
}

// Helper function to get token account balance, supporting both Token Program and Token-2022
async function getTokenAccountBalance(
  connection: Connection,
  mintAddress: PublicKey,
  ownerPublicKey: PublicKey
): Promise<{ balance: bigint; tokenProgramId: PublicKey; tokenAccount: PublicKey } | null> {
  // Try standard Token Program first
  let tokenAccount = await getAssociatedTokenAddress(
    mintAddress,
    ownerPublicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  try {
    const account = await getAccount(connection, tokenAccount, 'confirmed');
    return {
      balance: BigInt(account.amount.toString()),
      tokenProgramId: TOKEN_PROGRAM_ID,
      tokenAccount: tokenAccount,
    };
  } catch (e) {
    // Try Token-2022
    try {
      tokenAccount = await getAssociatedTokenAddress(
        mintAddress,
        ownerPublicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const accountInfo = await connection.getAccountInfo(tokenAccount, 'confirmed');
      if (accountInfo === null || !accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        return null;
      }

      // Parse balance from account data
      if (accountInfo.data.length >= 72) {
        const amountBytes = Buffer.from(accountInfo.data.slice(64, 72));
        const balance = amountBytes.readBigUInt64LE(0);
        return {
          balance,
          tokenProgramId: TOKEN_2022_PROGRAM_ID,
          tokenAccount: tokenAccount,
        };
      }
      return null;
    } catch (e2) {
      return null;
    }
  }
}

// Helper function to close ATA
async function closeATA(
  connection: Connection,
  tokenAccount: PublicKey,
  tokenProgramId: PublicKey,
  keypair: Keypair
): Promise<boolean> {
  try {
    // Check if account still exists and has 0 balance
    let shouldClose = false;
    
    if (tokenProgramId.equals(TOKEN_PROGRAM_ID)) {
      try {
        const account = await getAccount(connection, tokenAccount, 'confirmed');
        if (account.amount === BigInt(0)) {
          shouldClose = true;
        }
      } catch (e) {
        // Account might already be closed
        return false;
      }
    } else {
      // Token-2022
      const accountInfo = await connection.getAccountInfo(tokenAccount, 'confirmed');
      if (accountInfo === null) {
        return false; // Already closed
      }
      if (accountInfo.data.length >= 72) {
        const amountBytes = Buffer.from(accountInfo.data.slice(64, 72));
        const balance = amountBytes.readBigUInt64LE(0);
        if (balance === BigInt(0)) {
          shouldClose = true;
        }
      }
    }

    if (!shouldClose) {
      return false;
    }

    const programName = tokenProgramId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Standard Token';
    console.log(`   📝 Creating close account transaction (${programName})...`);
    
    const closeInstruction = createCloseAccountInstruction(
      tokenAccount,
      keypair.publicKey, // Destination for rent refund
      keypair.publicKey, // Owner
      [],
      tokenProgramId
    );

    const closeTransaction = new Transaction().add(closeInstruction);
    const { blockhash: closeBlockhash, lastValidBlockHeight: closeLastValidBlockHeight } = 
      await connection.getLatestBlockhash('confirmed');
    
    closeTransaction.recentBlockhash = closeBlockhash;
    closeTransaction.feePayer = keypair.publicKey;
    closeTransaction.sign(keypair);

    const closeSignature = await connection.sendRawTransaction(
      closeTransaction.serialize(),
      {
        skipPreflight: false,
        maxRetries: 3,
      }
    );

    console.log(`   ✅ Close transaction sent!`);
    console.log(`   📝 Signature: ${closeSignature}`);
    console.log(`   🔗 Explorer: https://solscan.io/tx/${closeSignature}`);

    // Confirm close transaction
    const closeConfirmation = await connection.confirmTransaction({
      signature: closeSignature,
      blockhash: closeBlockhash,
      lastValidBlockHeight: closeLastValidBlockHeight,
    }, 'confirmed');

    if (closeConfirmation.value.err) {
      console.error(`   ❌ Close transaction failed: ${closeConfirmation.value.err}`);
      return false;
    } else {
      console.log(`   ✅ Token account closed successfully! (${programName})`);
      console.log(`   💰 Rent refunded to wallet`);
      return true;
    }
  } catch (error: any) {
    console.error(`   ⚠️  Failed to close token account: ${error.message}`);
    return false;
  }
}

// Function to swap a single token to SOL
async function swapTokenToSOL(
  connection: Connection,
  keypair: Keypair,
  inputMint: string,
  slippageBps: number
): Promise<{ success: boolean; signature?: string; solReceived?: bigint; error?: string; tokenInfo?: { balance: bigint; tokenProgramId: PublicKey; tokenAccount: PublicKey } }> {
  let tokenInfo: { balance: bigint; tokenProgramId: PublicKey; tokenAccount: PublicKey } | null = null;
  
  try {
    // Get token balance
    const mintPubkey = new PublicKey(inputMint);
    tokenInfo = await getTokenAccountBalance(connection, mintPubkey, keypair.publicKey);
    
    if (!tokenInfo || tokenInfo.balance === BigInt(0)) {
      return { success: false, error: 'No balance found' };
    }

    const inAmount = tokenInfo.balance.toString();
    console.log(`   💰 Token balance: ${inAmount}`);

    // Get quote
    const quoteResponse = await getQuote(
      inputMint,
      WSOL_MINT,
      inAmount,
      slippageBps
    );

    console.log(`   📊 Quote: ${quoteResponse.outAmount} SOL (Price Impact: ${quoteResponse.priceImpactPct}%)`);

    // Get swap transaction
    const swapResponse = await getSwapTransaction(
      quoteResponse,
      keypair.publicKey,
      1000 // 0.001 SOL priority fee
    );

    // Sign and send
    const transactionBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuffer);
    transaction.sign([keypair]);

    const serializedTransaction = transaction.serialize();
    const signature = await connection.sendRawTransaction(serializedTransaction, {
      skipPreflight: false,
      maxRetries: 3,
    });

    console.log(`   ✅ Swap transaction sent!`);
    console.log(`   📝 Signature: ${signature}`);
    console.log(`   🔗 Explorer: https://solscan.io/tx/${signature}`);

    // Confirm transaction
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }, 'confirmed');

    if (confirmation.value.err) {
      return { success: false, error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`, tokenInfo: tokenInfo || undefined };
    }

    // Wait a bit for account to update
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get SOL balance change
    const solBalanceBefore = await connection.getBalance(keypair.publicKey, 'confirmed');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const solBalanceAfter = await connection.getBalance(keypair.publicKey, 'confirmed');
    const solReceived = BigInt(solBalanceAfter) - BigInt(solBalanceBefore);

    console.log(`   ✅ Swap confirmed! Received: ${solReceived.toString()} lamports (${(Number(solReceived) / 1e9).toFixed(9)} SOL)`);

    // Close ATA
    console.log(`   🗑️  Closing token account...`);
    await closeATA(connection, tokenInfo.tokenAccount, tokenInfo.tokenProgramId, keypair);

    return { success: true, signature, solReceived };
  } catch (error: any) {
    return { success: false, error: error.message, tokenInfo: tokenInfo || undefined };
  }
}

// Batch function to sell all tokens and close ATAs
async function sellAllTokensAndCloseATAs(): Promise<void> {
  try {
    const privateKeyBase58 = process.env.PRIVATE_KEY;
    const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '50', 10);
    const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const minSolValue = parseFloat(process.env.MIN_SOL_VALUE || '0.0001'); // Minimum SOL value to process (default 0.0001 SOL)

    if (!privateKeyBase58) {
      throw new Error('Missing PRIVATE_KEY environment variable');
    }

    // Parse private key
    let keypair: Keypair;
    try {
      const privateKeyBytes = bs58.decode(privateKeyBase58);
      keypair = Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
      throw new Error(`Invalid private key format. Expected base58 encoded string. Error: ${error}`);
    }

    console.log('🚀 Starting Batch Token Sale');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📍 Wallet: ${keypair.publicKey.toString()}`);
    console.log(`📉 Slippage: ${slippageBps} bps (${(slippageBps / 100).toFixed(2)}%)`);
    console.log(`💰 Minimum SOL value: ${minSolValue} SOL`);
    console.log(`🌐 RPC: ${rpcUrl}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const connection = new Connection(rpcUrl, 'confirmed');

    // Get initial SOL balance
    const solBalanceBefore = await connection.getBalance(keypair.publicKey, 'confirmed');
    console.log(`💰 Initial SOL balance: ${solBalanceBefore / 1e9} SOL\n`);

    // Automatically detect all tokens in the wallet
    console.log('🔍 Detecting all tokens in wallet...');
    const allTokenAccounts = await getAllTokenAccounts(connection, keypair.publicKey);
    console.log(`   Found ${allTokenAccounts.length} token(s) with balance > 0 (excluding WSOL)\n`);

    if (allTokenAccounts.length === 0) {
      console.log('✅ No tokens found to sell. Wallet is clean!');
      return;
    }

    // Filter tokens by minimum SOL value (check quote first)
    console.log('📊 Checking quotes and filtering by minimum value...');
    const tokensToProcess: Array<{ mint: string; balance: bigint; tokenProgramId: PublicKey; tokenAccount: PublicKey }> = [];
    const skippedTokens: Array<{ mint: string; reason: string }> = [];

    for (const tokenAccount of allTokenAccounts) {
      try {
        // Identify token program type
        const tokenType = tokenAccount.tokenProgramId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Standard Token';
        
        // Try to get a quote to check if it's worth selling
        const quoteResponse = await getQuote(
          tokenAccount.mint,
          WSOL_MINT,
          tokenAccount.balance.toString(),
          slippageBps
        );

        const solValue = Number(quoteResponse.outAmount) / 1e9;
        
        if (solValue < minSolValue) {
          skippedTokens.push({
            mint: tokenAccount.mint,
            reason: `Value too low: ${solValue.toFixed(9)} SOL (min: ${minSolValue} SOL) [${tokenType}]`
          });
          continue;
        }

        tokensToProcess.push(tokenAccount);
        console.log(`   ✅ ${tokenAccount.mint.slice(0, 8)}... - Value: ${solValue.toFixed(9)} SOL [${tokenType}]`);
      } catch (error: any) {
        // If quote fails, skip this token (might not have liquidity or not tradable)
        const tokenType = tokenAccount.tokenProgramId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Standard Token';
        const errorMessage = error.message || '';
        const errorLower = errorMessage.toLowerCase();
        let reason = `Quote failed: ${errorMessage}`;
        
        if (errorLower.includes('not tradable') || errorLower.includes('tradable')) {
          if (tokenType === 'Token-2022') {
            reason = `Token-2022 not tradable on Jupiter (may have transfer hooks/restrictions or not in registry)`;
          } else {
            reason = `Token not tradable on Jupiter (not in registry or restricted)`;
          }
        } else if (errorLower.includes('no route') || errorLower.includes('liquidity')) {
          reason = `No liquidity/route available [${tokenType}]`;
        } else {
          reason = `${reason} [${tokenType}]`;
        }
        
        skippedTokens.push({
          mint: tokenAccount.mint,
          reason
        });
        continue;
      }
    }

    console.log(`\n📦 Tokens to process: ${tokensToProcess.length}`);
    if (skippedTokens.length > 0) {
      console.log(`⏭️  Tokens skipped: ${skippedTokens.length}`);
      skippedTokens.forEach(skipped => {
        console.log(`   ⏭️  ${skipped.mint.slice(0, 8)}... - ${skipped.reason}`);
      });
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (tokensToProcess.length === 0) {
      console.log('✅ No tokens meet the minimum value threshold. Nothing to sell.');
      return;
    }

    const results: Array<{ mint: string; success: boolean; solReceived?: bigint; error?: string }> = [];
    let totalSolReceived = BigInt(0);

    // Process each token
    for (let i = 0; i < tokensToProcess.length; i++) {
      const tokenAccount = tokensToProcess[i];
      console.log(`\n[${i + 1}/${tokensToProcess.length}] Processing: ${tokenAccount.mint}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      const tokenType = tokenAccount.tokenProgramId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Standard Token';
      console.log(`   📋 Token Type: ${tokenType}`);
      
      const result = await swapTokenToSOL(connection, keypair, tokenAccount.mint, slippageBps);
      
      if (result.success) {
        results.push({ mint: tokenAccount.mint, success: true, solReceived: result.solReceived || BigInt(0) });
        totalSolReceived += result.solReceived || BigInt(0);
        console.log(`   ✅ Successfully sold and closed ATA`);
      } else {
        results.push({ mint: tokenAccount.mint, success: false, error: result.error || 'Unknown error' });
        console.log(`   ❌ Failed: ${result.error}`);
        
        // Try to close ATA even if swap failed (for non-tradable tokens, etc.)
        // Note: This will only succeed if balance is 0, which is unlikely if swap failed
        if (result.tokenInfo) {
          const errorLower = (result.error || '').toLowerCase();
          const isNotTradable = errorLower.includes('not tradable') || errorLower.includes('tradable');
          
          if (isNotTradable) {
            if (tokenType === 'Token-2022') {
              console.log(`   ⚠️  Token-2022 is not tradable on Jupiter. Cannot close ATA (balance: ${result.tokenInfo.balance.toString()})`);
              console.log(`   💡 Token-2022 may have transfer hooks, restrictions, or not be in Jupiter's registry.`);
              console.log(`   💡 The ATA will remain open with the token balance. Try alternative DEXs or wait for Jupiter support.`);
            } else {
              console.log(`   ⚠️  Token is not tradable on Jupiter. Cannot close ATA (balance: ${result.tokenInfo.balance.toString()})`);
              console.log(`   💡 This token cannot be sold via Jupiter. The ATA will remain open with the token balance.`);
            }
          } else {
            // For other errors, try to close ATA (might have been partially swapped or already 0)
            console.log(`   🗑️  Attempting to close ATA despite swap failure...`);
            const closed = await closeATA(connection, result.tokenInfo.tokenAccount, result.tokenInfo.tokenProgramId, keypair);
            if (!closed) {
              console.log(`   ⚠️  Could not close ATA - account may still have balance or already closed`);
            }
          }
        }
      }

      // Small delay between swaps to avoid rate limiting
      if (i < tokensToProcess.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Final summary
    console.log('\n\n🎉 Batch Processing Complete!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const solBalanceAfter = await connection.getBalance(keypair.publicKey, 'confirmed');
    const actualSolIncrease = BigInt(solBalanceAfter) - BigInt(solBalanceBefore);
    
    console.log(`\n📊 Summary:`);
    console.log(`   Total tokens detected: ${allTokenAccounts.length}`);
    console.log(`   Tokens processed: ${tokensToProcess.length}`);
    console.log(`   Tokens skipped: ${skippedTokens.length}`);
    console.log(`   Successful swaps: ${results.filter(r => r.success).length}`);
    console.log(`   Failed swaps: ${results.filter(r => !r.success).length}`);
    console.log(`   Total SOL received: ${totalSolReceived.toString()} lamports (${(Number(totalSolReceived) / 1e9).toFixed(9)} SOL)`);
    console.log(`   Final SOL balance: ${solBalanceAfter / 1e9} SOL`);
    console.log(`   Actual SOL increase: ${actualSolIncrease.toString()} lamports (${(Number(actualSolIncrease) / 1e9).toFixed(9)} SOL)`);

    console.log(`\n📋 Detailed Results:`);
    results.forEach((result, index) => {
      if (result.success) {
        console.log(`   ✅ [${index + 1}] ${result.mint.slice(0, 8)}... - Received: ${(Number(result.solReceived || 0) / 1e9).toFixed(9)} SOL`);
      } else {
        console.log(`   ❌ [${index + 1}] ${result.mint.slice(0, 8)}... - ${result.error}`);
      }
    });

  } catch (error: any) {
    console.error('\n❌ Error in batch processing:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the batch sell and close operation
sellAllTokensAndCloseATAs();
