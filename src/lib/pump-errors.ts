/**
 * Turns raw wallet / RPC errors from a pump transaction into messages a user
 * can act on (rule 3: never show a raw technical error for the rent minimum).
 * Pure function, no imports — unit-tested in tests/pump-rules.test.ts.
 */
export function humanizePumpError(err: unknown): string {
  const raw = err instanceof Error ? `${err.message} ${String((err as { logs?: unknown }).logs ?? "")}` : String(err);
  if (/InsufficientFundsForRent|insufficient funds for rent/i.test(raw)) {
    return (
      "Le réseau Solana a refusé ce pump : un des wallets qui le reçoit est vide, et la part qu'il recevrait " +
      "est trop faible pour l'activer. Essaie avec un montant plus élevé."
    );
  }
  if (/insufficient lamports|no record of a prior credit|insufficient funds/i.test(raw)) {
    return "Solde insuffisant sur ton wallet pour ce pump (montant + frais réseau).";
  }
  if (/user rejected|rejected the request|declined|cancell?ed/i.test(raw)) {
    return "Transaction annulée dans le wallet : rien n'a été envoyé.";
  }
  if (/blockhash not found|block height exceeded|expired/i.test(raw)) {
    return "La transaction a expiré avant d'être validée : rien n'a été envoyé. Réessaie.";
  }
  return err instanceof Error ? err.message : "Le pump a échoué.";
}
