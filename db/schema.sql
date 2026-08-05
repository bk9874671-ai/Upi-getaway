-- ============================================================
-- UPI Payment Gateway — PostgreSQL Schema
-- ============================================================
-- Design notes:
--   * order_id is the merchant-facing reference (unique).
--   * idempotency_key prevents duplicate payment creation on client
--     retries (e.g. flaky mobile networks re-submitting a request).
--   * status is constrained to a fixed set and moves through a
--     one-way state machine enforced in application logic
--     (PENDING -> SUCCESS | FAILED | EXPIRED). No reopening a
--     terminal state.
--   * rrn (Retrieval Reference Number) is the NPCI/bank transaction
--     reference returned by the webhook — used for reconciliation.
--   * All monetary values stored in paise (integer) to avoid
--     floating-point rounding issues; convert to rupees at the edges.
-- ============================================================

CREATE TABLE IF NOT EXISTS upi_transactions (
    id                  BIGSERIAL PRIMARY KEY,
    order_id            VARCHAR(64)  NOT NULL UNIQUE,
    idempotency_key     VARCHAR(128) NOT NULL UNIQUE,
    amount_paise        BIGINT       NOT NULL CHECK (amount_paise > 0),
    currency            VARCHAR(3)   NOT NULL DEFAULT 'INR',
    customer_upi        VARCHAR(128),
    merchant_vpa        VARCHAR(128) NOT NULL,
    upi_string          TEXT         NOT NULL,
    status              VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED')),
    rrn                 VARCHAR(64),                 -- bank/NPCI Retrieval Reference Number
    psp_ref_id          VARCHAR(128),                -- aggregator's own transaction id
    failure_reason      TEXT,
    webhook_payload      JSONB,                      -- last raw webhook body, for audit/reconciliation
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_upi_transactions_status ON upi_transactions (status);
CREATE INDEX IF NOT EXISTS idx_upi_transactions_created_at ON upi_transactions (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upi_transactions_rrn ON upi_transactions (rrn) WHERE rrn IS NOT NULL;

-- Auto-maintain updated_at on every row change.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_upi_transactions_updated_at ON upi_transactions;
CREATE TRIGGER trg_upi_transactions_updated_at
    BEFORE UPDATE ON upi_transactions
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Table to log every webhook attempt for audit + replay protection
-- (separate from the transaction row so retried/duplicate webhooks
-- for the same order are still fully visible in history).
CREATE TABLE IF NOT EXISTS upi_webhook_events (
    id              BIGSERIAL PRIMARY KEY,
    order_id        VARCHAR(64),
    signature       TEXT,
    event_id        VARCHAR(128) UNIQUE, -- PSP-provided unique event id, if any, for dedup
    raw_payload     JSONB NOT NULL,
    verified        BOOLEAN NOT NULL,
    processed       BOOLEAN NOT NULL DEFAULT false,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_order_id ON upi_webhook_events (order_id);
