# Jupiter Swap

A standalone utility to swap tokens on Solana using Jupiter Aggregator API.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file and configure it:
```env
BASE_TOKEN_ADDRESS=So11111111111111111111111111111111111111112
QUOTE_TOKEN_ADDRESS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
PRIVATE_KEY=your_base58_private_key_here
IN_AMOUNT=100000000
SLIPPAGE_BPS=50

# Strategy bot settings (SOL per 1 token)
QUOTE_TOKEN_DECIMALS=6
BUY_BELOW_SOL=0.001499
SELL_ABOVE_SOL=0.0017
CHECK_INTERVAL_MS=5000
PRIORITY_FEE_LAMPORTS=1000000
```

## Environment Variables

- `BASE_TOKEN_ADDRESS`: Base mint address (SOL/WSOL: `So11111111111111111111111111111111111111112`)
- `QUOTE_TOKEN_ADDRESS`: Token mint you want to trade
- `PRIVATE_KEY`: Your wallet's private key in base58 format
- `IN_AMOUNT`: Amount to swap in smallest unit (e.g., for SOL: 100000000 = 0.1 SOL if 9 decimals)
- `SLIPPAGE_BPS`: Slippage tolerance in basis points (50 = 0.5%, 100 = 1%)
- `RPC_URL`: (Optional) Solana RPC endpoint (defaults to mainnet)
- `QUOTE_TOKEN_DECIMALS`: Quote token decimals (used for price math)
- `BUY_BELOW_SOL`: Buy when effective price (SOL per token) is <= this threshold
- `SELL_ABOVE_SOL`: Sell all tokens when effective price (SOL per token) is >= this threshold
- `CHECK_INTERVAL_MS`: How often to check price/balances (default: 5000ms)
- `PRIORITY_FEE_LAMPORTS`: Max priority fee in lamports (default: 1,000,000 = 0.001 SOL)

## Usage

### Development (TypeScript)
```bash
npm run dev
```

### Production (Compiled)
```bash
npm run build
npm start
```

### Direct Run
```bash
npm run swap
```

## Strategy Logic

This project runs a simple threshold strategy:

- Buy when `price <= BUY_BELOW_SOL` (spends `IN_AMOUNT` lamports of SOL)
- Sell when `price >= SELL_ABOVE_SOL` (sells **all** quote tokens in your wallet)
- After buying once, it will not buy again until you sell (position is inferred from your wallet's quote token balance)
- Price is derived from Jupiter quotes at your configured trade size (so it reflects slippage/impact)

## How to Get Your Private Key

### From Phantom Wallet:
1. Open Phantom
2. Settings → Security & Privacy → Export Private Key
3. Copy the base58 encoded string

### From Solana CLI:
```bash
solana-keygen recover 'prompt://?full-path=/path/to/keypair.json'
```

## Example

Swap 0.1 SOL to USDC:
```env
BASE_TOKEN_ADDRESS=So11111111111111111111111111111111111111112
QUOTE_TOKEN_ADDRESS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
IN_AMOUNT=100000000
SLIPPAGE_BPS=50
```

## Security Warning

⚠️ **NEVER commit your `.env` file to git!** It contains your private key.

The `.gitignore` file is configured to exclude `.env` files.

## Network

This project is configured for **Solana Mainnet** by default.

To use a different network, set the `RPC_URL` environment variable.

## License

MIT

