// Public testnet token allowlist; never substitute mainnet contracts or mints.
export const TIDEPOOL_BASE_URL = 'https://www.usetidepool.tech';
export const TIDEPOOL_VERIFIER = 'verifier.tidepool-sandbox.testnet';
export const TIDEPOOL_TOKENS = {
  nearUsdc: {
    assetId: 'nep141:usdc.tidepool-sandbox.testnet',
    blockchain: 'near',
    symbol: 'USDC',
    contract: 'usdc.tidepool-sandbox.testnet',
  },
  nearUsdt: {
    assetId: 'nep141:usdt.tidepool-sandbox.testnet',
    blockchain: 'near',
    symbol: 'USDT',
    contract: 'usdt.tidepool-sandbox.testnet',
  },
  baseUsdc: {
    assetId: 'nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet',
    blockchain: 'base',
    symbol: 'USDC',
    contract: '0x38d81431B9f76d9699AF7517040D5221D9dEA252',
  },
  baseUsdt: {
    assetId: 'nep141:base-0xc15cf5600225302675604310094f134e88705e62.tp-omft.testnet',
    blockchain: 'base',
    symbol: 'USDT',
    contract: '0xC15Cf5600225302675604310094f134e88705E62',
  },
  solUsdc: {
    assetId: 'nep141:sol-d48c1adc423a64867ac91ed2e1c0df76da323235.tp-omft.testnet',
    blockchain: 'sol',
    symbol: 'USDC',
    contract: '7pafEGXSmR35rLKNaD6inpfLYuEnRX9DyBc1c7M8r4Xr',
  },
  solUsdt: {
    assetId: 'nep141:sol-4c5179da74eb695eb57e01b787c4937157cf2833.tp-omft.testnet',
    blockchain: 'sol',
    symbol: 'USDT',
    contract: 'H9ERDhrU8KDeXkMna2Lw6hYJT3LSyhvypiktDc6zmoeJ',
  },
} as const;
