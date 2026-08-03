-- 0002_ledger.sql
--
-- TARGET DATABASE: ai_os  (host postgres, 127.0.0.1:5434)  -- NOT content_forge
-- Apply with:
--   sudo -u postgres psql -p 5434 -d ai_os -f db/migrations-ai-os/0002_ledger.sql
--
-- THE CASH LEDGER — the AI OS's first real system-of-record.
--
-- Why this table and not a CRM or an ERP: Mentor/Profile/OPEN-QUESTIONS.md has
-- asked "what is your actual current revenue and burn?" since 2026-07-03 and it
-- is still unanswered; the only figure on record (-$300/week) is from Feb 2026.
-- The stated purpose of this whole system is to make money, and you cannot
-- compound a number nobody measures. A CRM for ~10 Axtrelis clients would be
-- theatre; this answers a question that is actually open.
--
-- Design decisions worth not re-litigating later:
--
--  * occurred_on is a DATE, not a timestamptz. Cash reconciles by day, against
--    bank statements that have no clock. A timestamp would invent precision
--    that the underlying truth does not have.
--
--  * amount is always POSITIVE and `direction` carries the sign. Signed amounts
--    invite a missing ABS() somewhere to silently turn income into burn.
--
--  * is_cash separates real money from notional cost. This is not academic:
--    every one of the 172 rows currently in content_forge.spend_log is
--    provider 'claude-code', which db/spend.ts documents as a SHADOW price on
--    a flat-rate subscription — tokens that were never billed. Importing that
--    as cash would overstate burn by ~EUR 176 of money that never left an
--    account. Shadow rows land here with is_cash = FALSE so they can be shown
--    without ever moving the number that matters.
--
--  * (source, external_ref) is UNIQUE so importers are idempotent. Re-running
--    an import must never double-count revenue; that is how ledgers lie.

CREATE TABLE IF NOT EXISTS ledger_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Cash date. See note above: deliberately a DATE.
  occurred_on   DATE NOT NULL,

  -- 'in'  = money arrived (revenue, capital injection)
  -- 'out' = money left   (payroll, software, fees)
  direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),

  -- Always positive. Sign lives in `direction`, never here.
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency      TEXT NOT NULL DEFAULT 'EUR' CHECK (char_length(currency) = 3),

  -- Normalised to EUR for cross-arm totals. NULL until an FX rate is applied,
  -- so an un-converted USD row can never be silently summed as if it were EUR.
  amount_eur    NUMERIC(14,2),

  -- Which part of the operation this belongs to. 'infra' is shared cost that
  -- is not yet allocated to an arm; 'personal' keeps life expenses in the same
  -- ledger without polluting business unit economics.
  arm           TEXT NOT NULL CHECK (arm IN
                  ('axtrelis', 'youtube', 'infra', 'personal', 'other')),

  -- Free text by design. A fixed enum would need a migration every time a new
  -- cost appears, which is exactly when someone stops recording instead.
  -- Convention: va_payroll, software, adsense, client_invoice, capital, fees.
  category      TEXT NOT NULL,

  counterparty  TEXT,
  memo          TEXT,

  -- FALSE = notional/shadow cost. Excluded from every cash figure.
  is_cash       BOOLEAN NOT NULL DEFAULT TRUE,

  -- manual | spend_log | sheets | adsense | stripe ...
  source        TEXT NOT NULL DEFAULT 'manual',

  -- Stable id from the source system. Makes re-import idempotent.
  external_ref  TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent import. Partial, because manual entries legitimately have no ref
-- and several of them may be identical (two identical coffee receipts are two
-- real events, not a duplicate).
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_source_ref_uniq
  ON ledger_entries (source, external_ref)
  WHERE external_ref IS NOT NULL;

-- The access pattern is almost always "a date window, grouped by arm".
CREATE INDEX IF NOT EXISTS ledger_entries_occurred_arm_idx
  ON ledger_entries (occurred_on DESC, arm);

CREATE INDEX IF NOT EXISTS ledger_entries_category_idx
  ON ledger_entries (category);
