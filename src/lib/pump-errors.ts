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
  if (/insufficient lamports|no record of a prior credit|insufficient funds|AccountNotFound/i.test(raw)) {
    return "Solde insuffisant sur ton wallet pour ce pump (montant + frais réseau).";
  }
  if (/user rejected|rejected the request|declined|cancell?ed/i.test(raw)) {
    return "Transaction annulée dans le wallet : rien n'a été envoyé.";
  }
  if (/blockhash not found|block height exceeded|expired/i.test(raw)) {
    return "La transaction a expiré avant d'être validée : rien n'a été envoyé. Réessaie.";
  }
  if (/unexpected error/i.test(raw)) {
    // Wallets (Phantom…) return this bare message when they fail to submit,
    // most often because the wallet is set to another network than devnet.
    return (
      "Ton wallet a refusé la transaction sans donner de raison. Vérifie qu'il est réglé sur " +
      "Solana Devnet (Phantom : Paramètres → Paramètres développeur → Mode testnet → Solana Devnet), " +
      "puis réessaie."
    );
  }
  return err instanceof Error ? err.message : "Le pump a échoué.";
}
