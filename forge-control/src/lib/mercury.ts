/**
 * Mercury Bank REST Client & Treasury Balances
 *
 * Provides read-only access to Mercury bank accounts via
 * https://api.mercury.com/api/v1/accounts and manages Treasury & private
 * banking account balance structures (Mercury 3x accounts + E&G Private Bank).
 *
 * Credential Handling:
 * Reads MERCURY_API_TOKEN / MERCURY_API_KEY from environment or secret-store.
 * Never leaks token material to API responses or logs.
 */

import { getSecret } from "./secret-store.ts";

export const MERCURY_API_URL = "https://api.mercury.com/api/v1/accounts";

/**
 * A STATIC rate, not a quote. Nothing here fetches an FX feed, so every
 * USD→EUR figure this module produces is an approximation at this constant,
 * and `fx_rate_source` says so in the response — a consumer that renders
 * "≈ €X" without that qualifier is publishing a made-up number as a fact.
 *
 * Currently inert: no account is linked, so no conversion is performed. It
 * stops being inert the moment MERCURY_API_TOKEN lands.
 */
export const USD_EUR_FX_RATE = 1.08;
export type FxRateSource = "static_fallback" | "live_quote";
export const USD_EUR_FX_SOURCE: FxRateSource = "static_fallback";

export type AccountStatus = "active" | "unlinked" | "error" | "manual";
export type AccountType = "checking" | "savings" | "treasury" | "private_banking";

export interface BankAccount {
  id: string;
  name: string;
  institution: "mercury" | "eg_bank" | "other";
  account_number_mask: string | null;
  type: AccountType;
  currency: "USD" | "EUR";
  current_balance: number;
  available_balance: number;
  balance_usd: number;
  balance_eur: number;
  status: AccountStatus;
  status_detail: string | null;
  last_synced_at: string | null;
}

export interface BankBalancesResponse {
  connected: boolean;
  mercury: {
    connected: boolean;
    credential_required: boolean;
    secret_name: string;
    accounts: BankAccount[];
    error: string | null;
  };
  eg_bank: BankAccount;
  accounts: BankAccount[];
  total_liquid_eur: number;
  total_usd: number;
  fx_rate_usd_eur: number;
  /** Where `fx_rate_usd_eur` came from. `static_fallback` means it is a
   *  constant in this file, NOT a quote — render it as such. */
  fx_rate_source: FxRateSource;
  as_of: string;
}

interface MercuryApiAccount {
  id?: string;
  name?: string;
  nickname?: string;
  accountNumber?: string;
  routingNumber?: string;
  currentBalance?: number;
  availableBalance?: number;
  type?: string;
  status?: string;
  legalBusinessName?: string;
  createdAt?: string;
}

interface MercuryApiResponse {
  accounts?: MercuryApiAccount[];
  total?: number;
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

/**
 * Retrieve Mercury API token from environment or secret store.
 * Secret store names are checked in normalized form (lowercase, dashes/underscores).
 */
export async function getMercuryToken(): Promise<string | null> {
  if (process.env.MERCURY_API_TOKEN && process.env.MERCURY_API_TOKEN.trim()) {
    return process.env.MERCURY_API_TOKEN.trim();
  }
  if (process.env.MERCURY_API_KEY && process.env.MERCURY_API_KEY.trim()) {
    return process.env.MERCURY_API_KEY.trim();
  }

  const candidateNames = [
    "mercury_api_token",
    "mercury-api-token",
    "mercury_api_key",
    "mercury-api-key",
    "mercury",
  ];

  for (const name of candidateNames) {
    try {
      const val = await getSecret(name);
      if (val && val.trim()) {
        return val.trim();
      }
    } catch {
      // Continue searching candidate names
    }
  }

  return null;
}

/**
 * Default status shells for Mercury's 3 structured accounts when unlinked.
 */
export function getUnlinkedMercuryAccounts(): BankAccount[] {
  return [
    {
      id: "mercury-operating",
      name: "Mercury Operating",
      institution: "mercury",
      account_number_mask: null,
      type: "checking",
      currency: "USD",
      current_balance: 0,
      available_balance: 0,
      balance_usd: 0,
      balance_eur: 0,
      status: "unlinked",
      status_detail: "Credential required via secrets panel (MERCURY_API_TOKEN)",
      last_synced_at: null,
    },
    {
      id: "mercury-treasury",
      name: "Mercury Treasury",
      institution: "mercury",
      account_number_mask: null,
      type: "treasury",
      currency: "USD",
      current_balance: 0,
      available_balance: 0,
      balance_usd: 0,
      balance_eur: 0,
      status: "unlinked",
      status_detail: "Credential required via secrets panel (MERCURY_API_TOKEN)",
      last_synced_at: null,
    },
    {
      id: "mercury-tax-reserve",
      name: "Mercury Tax Reserve",
      institution: "mercury",
      account_number_mask: null,
      type: "savings",
      currency: "USD",
      current_balance: 0,
      available_balance: 0,
      balance_usd: 0,
      balance_eur: 0,
      status: "unlinked",
      status_detail: "Credential required via secrets panel (MERCURY_API_TOKEN)",
      last_synced_at: null,
    },
  ];
}

/**
 * Fetch Mercury account balances from official REST API.
 */
export async function fetchMercuryAccounts(): Promise<{
  connected: boolean;
  accounts: BankAccount[];
  error: string | null;
  credentialRequired: boolean;
}> {
  const token = await getMercuryToken();
  if (!token) {
    return {
      connected: false,
      accounts: getUnlinkedMercuryAccounts(),
      error: null,
      credentialRequired: true,
    };
  }

  try {
    const res = await fetch(MERCURY_API_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "forge-control/0.2.0 (Hetzner VPS)",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const errorMsg = `Mercury API returned HTTP ${res.status}: ${bodyText.slice(0, 200)}`;
      return {
        connected: false,
        accounts: getUnlinkedMercuryAccounts().map((acc) => ({
          ...acc,
          status: "error",
          status_detail: errorMsg,
        })),
        error: errorMsg,
        credentialRequired: res.status === 401 || res.status === 403,
      };
    }

    const data = (await res.json()) as MercuryApiResponse;
    const rawAccounts = Array.isArray(data.accounts)
      ? data.accounts
      : Array.isArray(data)
        ? (data as MercuryApiAccount[])
        : [];

    if (rawAccounts.length === 0) {
      return {
        connected: true,
        accounts: getUnlinkedMercuryAccounts().map((acc) => ({
          ...acc,
          status: "active",
          status_detail: "Connected (no accounts returned)",
          last_synced_at: new Date().toISOString(),
        })),
        error: null,
        credentialRequired: false,
      };
    }

    const nowIso = new Date().toISOString();
    const mapped: BankAccount[] = rawAccounts.map((raw) => {
      const balanceUsd = Number(raw.availableBalance ?? raw.currentBalance ?? 0);
      const balanceEur = round2(balanceUsd / USD_EUR_FX_RATE);
      const accNum = typeof raw.accountNumber === "string" ? raw.accountNumber : "";
      const mask = accNum.length >= 4 ? `…${accNum.slice(-4)}` : null;
      const rawName = (raw.nickname || raw.name || "Mercury Account").trim();
      const rawType = (raw.type || "checking").toLowerCase();

      let accType: AccountType = "checking";
      if (rawType.includes("sav")) accType = "savings";
      else if (rawType.includes("treas")) accType = "treasury";

      return {
        id: raw.id || `mercury-${rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: rawName,
        institution: "mercury",
        account_number_mask: mask,
        type: accType,
        currency: "USD",
        current_balance: Number(raw.currentBalance ?? balanceUsd),
        available_balance: balanceUsd,
        balance_usd: balanceUsd,
        balance_eur: balanceEur,
        status: (raw.status === "active" || !raw.status ? "active" : "error") as AccountStatus,
        status_detail: raw.status && raw.status !== "active" ? `Mercury status: ${raw.status}` : null,
        last_synced_at: nowIso,
      };
    });

    return {
      connected: true,
      accounts: mapped,
      error: null,
      credentialRequired: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      connected: false,
      accounts: getUnlinkedMercuryAccounts().map((acc) => ({
        ...acc,
        status: "error",
        status_detail: `Connection error: ${message}`,
      })),
      error: message,
      credentialRequired: false,
    };
  }
}

/**
 * Balance shell / manual balance representation for E&G Private Bank (EU/Germany).
 */
export async function getEgBankAccount(): Promise<BankAccount> {
  let manualBalanceEur = 0;
  if (process.env.EG_BANK_BALANCE_EUR) {
    const parsed = parseFloat(process.env.EG_BANK_BALANCE_EUR);
    if (Number.isFinite(parsed)) manualBalanceEur = parsed;
  } else {
    const secret = await getSecret("eg-bank-balance").catch(() => null);
    if (secret) {
      const parsed = parseFloat(secret);
      if (Number.isFinite(parsed)) manualBalanceEur = parsed;
    }
  }

  const balanceUsd = round2(manualBalanceEur * USD_EUR_FX_RATE);
  const hasConfiguredBalance = manualBalanceEur > 0;

  return {
    id: "eg-bank-private",
    name: "E&G Private Bank",
    institution: "eg_bank",
    account_number_mask: null,
    type: "private_banking",
    currency: "EUR",
    current_balance: manualBalanceEur,
    available_balance: manualBalanceEur,
    balance_usd: balanceUsd,
    balance_eur: manualBalanceEur,
    status: hasConfiguredBalance ? "manual" : "unlinked",
    status_detail: hasConfiguredBalance
      ? "Manual balance tracking · Open Banking / GoCardless available"
      : "Open Banking (GoCardless) / Manual entry required",
    last_synced_at: hasConfiguredBalance ? new Date().toISOString() : null,
  };
}

/**
 * Return all treasury bank balances with EUR equivalents and aggregate totals.
 */
export async function getBankBalances(): Promise<BankBalancesResponse> {
  const mercuryResult = await fetchMercuryAccounts();
  const egBank = await getEgBankAccount();

  const allAccounts = [...mercuryResult.accounts, egBank];
  const totalLiquidEur = round2(
    allAccounts.reduce((sum, acc) => sum + (acc.balance_eur || 0), 0),
  );
  const totalUsd = round2(
    allAccounts.reduce((sum, acc) => sum + (acc.balance_usd || 0), 0),
  );

  return {
    connected: mercuryResult.connected || egBank.status === "manual",
    mercury: {
      connected: mercuryResult.connected,
      credential_required: mercuryResult.credentialRequired,
      secret_name: "MERCURY_API_TOKEN",
      accounts: mercuryResult.accounts,
      error: mercuryResult.error,
    },
    eg_bank: egBank,
    accounts: allAccounts,
    total_liquid_eur: totalLiquidEur,
    total_usd: totalUsd,
    fx_rate_usd_eur: USD_EUR_FX_RATE,
    fx_rate_source: USD_EUR_FX_SOURCE,
    as_of: new Date().toISOString(),
  };
}
