# Solana Trading Bot - Top 100 DexScreener Tokens

A sophisticated automated trading bot for the Solana blockchain that monitors the top 100 trending tokens on DexScreener and executes trades automatically based on predefined criteria. Built with TypeScript and integrated with Jupiter Aggregator for optimal swap routing.

## Overview

This trading bot continuously monitors the Solana ecosystem, tracking the top 100 trending tokens listed on DexScreener. It analyzes market conditions in real-time and executes buy/sell orders automatically when predefined trading criteria are met, enabling 24/7 automated trading without manual intervention.

## Features

- 🔄 **Automated Trading**: Executes trades automatically based on configurable price thresholds
- 📊 **DexScreener Integration**: Monitors top 100 trending tokens on DexScreener
- 🚀 **Jupiter Aggregator**: Leverages Jupiter's routing for optimal swap execution
- ⚡ **Real-time Monitoring**: Continuous price monitoring with configurable check intervals
- 💰 **Smart Position Management**: Automatically detects holdings and manages buy/sell cycles
- 🛡️ **Slippage Protection**: Configurable slippage tolerance to protect against unfavorable trades
- 🔒 **Priority Fees**: Customizable priority fees for faster transaction confirmation
- 📈 **Price Impact Analysis**: Real-time price impact calculation for informed trading decisions
- 🧹 **Token Account Cleanup**: Automatically closes empty token accounts to recover rent

## Architecture

The bot operates on a continuous monitoring loop:

1. **Token Monitoring**: Tracks the top 100 tokens from DexScreener
2. **Price Analysis**: Fetches real-time quotes from Jupiter Aggregator
3. **Strategy Evaluation**: Compares current prices against buy/sell thresholds
4. **Trade Execution**: Executes swaps when criteria are met
5. **Position Tracking**: Monitors wallet balances to determine current positions

## Prerequisites

- Node.js 18+ and npm
- A Solana wallet with SOL for trading and transaction fees
- Solana RPC endpoint (defaults to public mainnet, but a private RPC is recommended)

## Installation

1. **Clone the repository**:
```bash
git clone <repository-url>
cd solana-trading-bot-100
```

2. **Install dependencies**:
```bash
npm install
```

3. **Create environment configuration**:
```bash
cp .env.example .env
```

4. **Configure your `.env` file** (see Configuration section below)

## Configuration

Create a `.env` file in the root directory with the following variables:

### Required Variables

```env
# Wallet Configuration
PRIVATE_KEY=your_base58_private_key_here

# Token Configuration
QUOTE_TOKEN_ADDRESS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
BASE_TOKEN_ADDRESS=So11111111111111111111111111111111111111112
QUOTE_TOKEN_DECIMALS=6

# Trading Parameters
IN_AMOUNT=100000000
SLIPPAGE_BPS=50

# Strategy Thresholds (SOL per token)
BUY_BELOW_SOL=0.001499
SELL_ABOVE_SOL=0.0017

# Bot Settings
CHECK_INTERVAL_MS=5000
PRIORITY_FEE_LAMPORTS=1000000

# Network (Optional)
RPC_URL=https://api.mainnet-beta.solana.com
```

### Environment Variables Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `PRIVATE_KEY` | Your wallet's private key in base58 format | **Required** |
| `QUOTE_TOKEN_ADDRESS` | Token mint address to trade | **Required** |
| `BASE_TOKEN_ADDRESS` | Base token (usually SOL/WSOL) | `So11111111111111111111111111111111111111112` |
| `QUOTE_TOKEN_DECIMALS` | Decimal places for the quote token | `6` |
| `IN_AMOUNT` | Amount to swap in smallest unit (lamports for SOL) | **Required** |
| `SLIPPAGE_BPS` | Slippage tolerance in basis points (50 = 0.5%) | `50` |
| `BUY_BELOW_SOL` | Buy threshold: price in SOL per token | `0.000018` |
| `SELL_ABOVE_SOL` | Sell threshold: price in SOL per token | `0.000020` |
| `CHECK_INTERVAL_MS` | Price check interval in milliseconds | `5000` |
| `PRIORITY_FEE_LAMPORTS` | Maximum priority fee in lamports | `1000000` |
| `RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |

## Usage

### Development Mode

Run the bot in development mode with TypeScript:

```bash
npm run dev
```

### Production Mode

Build and run the compiled version:

```bash
npm run build
npm start
```

### Direct Execution

Run directly with ts-node:

```bash
npm run swap
```

## Trading Strategy

The bot implements a threshold-based trading strategy:

### Buy Logic
- **Trigger**: When current price ≤ `BUY_BELOW_SOL` (SOL per token)
- **Action**: Spends `IN_AMOUNT` lamports of SOL to buy tokens
- **Condition**: Only executes if wallet has sufficient SOL balance

### Sell Logic
- **Trigger**: When current price ≥ `SELL_ABOVE_SOL` (SOL per token)
- **Action**: Sells **all** quote tokens in the wallet
- **Condition**: Only executes if wallet holds the quote token

### Position Detection
- The bot automatically detects your position by checking wallet balance
- After buying, it will not buy again until you sell (prevents over-buying)
- Price calculations use Jupiter quotes at your configured trade size, accounting for slippage and market impact

## Getting Your Private Key

### From Phantom Wallet

1. Open Phantom wallet
2. Navigate to **Settings** → **Security & Privacy** → **Export Private Key**
3. Copy the base58 encoded string
4. Paste it into your `.env` file as `PRIVATE_KEY`

### From Solana CLI

```bash
solana-keygen recover 'prompt://?full-path=/path/to/keypair.json'
```

**⚠️ Security Warning**: Never share your private key or commit it to version control!

## Example Configuration

### Trading USDC

```env
BASE_TOKEN_ADDRESS=So11111111111111111111111111111111111111112
QUOTE_TOKEN_ADDRESS=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
QUOTE_TOKEN_DECIMALS=6
IN_AMOUNT=100000000
SLIPPAGE_BPS=50
BUY_BELOW_SOL=0.001499
SELL_ABOVE_SOL=0.0017
```

This configuration:
- Trades SOL ↔ USDC
- Buys when price ≤ 0.001499 SOL per USDC
- Sells when price ≥ 0.0017 SOL per USDC
- Uses 0.1 SOL (100,000,000 lamports) per buy order
- Allows 0.5% slippage

## Security Best Practices

1. **Never commit `.env` files**: The `.gitignore` is configured to exclude `.env` files
2. **Use environment variables**: Store sensitive data in `.env`, never in code
3. **Private RPC endpoint**: Consider using a private RPC endpoint for better reliability
4. **Start with small amounts**: Test with minimal amounts before scaling up
5. **Monitor transactions**: Regularly check your wallet and transaction history
6. **Secure key storage**: Use hardware wallets or secure key management systems for production

## Network Configuration

The bot is configured for **Solana Mainnet** by default. To use a different network:

1. Set the `RPC_URL` environment variable to your desired endpoint
2. Ensure your wallet has funds on the target network
3. Verify token addresses are valid for the selected network

### Recommended RPC Providers

- **Helius**: `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`
- **QuickNode**: `https://YOUR_ENDPOINT.solana-mainnet.quiknode.pro/YOUR_KEY/`
- **Triton**: `https://YOUR_ENDPOINT.rpcpool.com/YOUR_KEY`

## Troubleshooting

### Common Issues

**Rate Limiting**: If you encounter rate limit errors, the bot will automatically retry with exponential backoff.

**Insufficient Balance**: Ensure your wallet has enough SOL for:
- Trading amounts (`IN_AMOUNT`)
- Transaction fees
- Priority fees (`PRIORITY_FEE_LAMPORTS`)
- Token account rent (if applicable)

**Transaction Failures**: Check:
- RPC endpoint connectivity
- Sufficient SOL balance for fees
- Valid token addresses
- Network congestion (may need higher priority fees)

## Development

### Project Structure

```
solana-trading-bot-100/
├── src/
│   └── index.ts          # Main bot logic
├── .env                  # Environment configuration (not in git)
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

### Building

```bash
npm run build
```

The compiled JavaScript will be output to the `dist/` directory.

## License

MIT License - see LICENSE file for details

## Disclaimer

This software is provided for educational and research purposes only. Automated trading involves substantial risk of loss. Past performance does not guarantee future results. Always:

- Test thoroughly with small amounts
- Understand the risks involved
- Never invest more than you can afford to lose
- Comply with all applicable laws and regulations

The authors and contributors are not responsible for any financial losses incurred through the use of this software.

## Support

For issues, questions, or contributions, please open an issue on the repository.


**Built with ❤️ for the Solana ecosystem**

