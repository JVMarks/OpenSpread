// O que cada rede entrega ao vigia de carteiras.
import type { WalletChain, WalletOp } from '../types';

export interface ReadResult {
  /** Só operações novas (as de `seen` não voltam). */
  ops: WalletOp[];
  balance?: { asset: string; amount: number };
  /** A fonte pediu para esperar no meio da leitura: `ops` é o que deu para ler; o vigia recua. */
  limited?: { retryAfterMs: number | null };
}

export interface ChainReader {
  chain: WalletChain;
  /** Host da fonte, para mostrar na tela ("api.mainnet-beta.solana.com"). */
  source: string;
  /** Moeda da rede ('SOL', 'ETH', 'BTC'). */
  native: string;
  /** Lê as transações recentes de um endereço, sem repetir as de `seen`. */
  read(address: string, seen: ReadonlySet<string>): Promise<ReadResult>;
  /** Sem a chave necessária (Base sem Blockscout PRO): motivo para mostrar no lugar de tentar. */
  unavailable?(): string | null;
}
