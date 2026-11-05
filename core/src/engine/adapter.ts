// Quem executa as operações que a trava aprovou. Nesta etapa só o PaperEngine; o gerente não sabe qual é.

/** Compra em `buyOn` e venda em `sellOn` de `sizeUsd`, com a cotação vista ao decidir. Taxas em fração (0,001 = 0,1%). */
export interface ExecutionRequest {
  pair: string;
  buyOn: string;
  sellOn: string;
  sizeUsd: number;
  quotedAsk: number;
  quotedBid: number;
  buyFee: number;
  sellFee: number;
}

export type Execution =
  | {
      ok: true;
      at: number;
      /** Quantidade da moeda-base nas duas pernas. */
      base: number;
      buyAvg: number;
      sellAvg: number;
      feesUsd: number;
      /** Resultado já com as taxas; negativo quando o livro piorou. */
      pnlUsd: number;
      /** Resultado em % do que a compra custou. */
      realizedNetPct: number;
      /** O livro não tinha o tamanho pedido. */
      partial: boolean;
    }
  | { ok: false; at: number; code: 'book_unavailable'; message: string };

export interface EngineAdapter {
  readonly kind: 'paper';
  execute(req: ExecutionRequest): Promise<Execution>;
}
