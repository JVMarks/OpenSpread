// Links públicos dos exploradores (o usuário confere cada operação lá). Nada de link com parâmetro de rastreio.
import type { WalletChain } from '../types';

const BASE: Readonly<Record<WalletChain, { tx: string; address: string }>> = {
  solana: { tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/' },
  ethereum: { tx: 'https://etherscan.io/tx/', address: 'https://etherscan.io/address/' },
  base: { tx: 'https://basescan.org/tx/', address: 'https://basescan.org/address/' },
  bitcoin: { tx: 'https://mempool.space/tx/', address: 'https://mempool.space/address/' },
};

export const txUrl = (chain: WalletChain, tx: string): string => BASE[chain].tx + encodeURIComponent(tx);
export const addressUrl = (chain: WalletChain, address: string): string => BASE[chain].address + encodeURIComponent(address);
