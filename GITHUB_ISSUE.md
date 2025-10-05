# Race condition in mint_quote_payments causing "Payment ID already exists" errors

## Description

The CDK mint has a race condition in the `increment_mint_quote_amount_paid()` function that causes "Payment ID already exists" errors even when clients send requests sequentially.

## Environment

- **CDK Version**: Latest (main branch as of 2025-10-02)
- **Database**: PostgreSQL 17 and SQLite
- **Backend**: fakewallet
- **Deployment**: Docker with cdk-mintd

## Steps to Reproduce

1. Set up a CDK mint with fakewallet backend (for instant confirmations)
2. Configure PostgreSQL or SQLite database
3. From a web client, rapidly request mint quotes sequentially (e.g., 100 sequential requests)
4. Observe errors in mint logs

### Minimal Reproduction

```typescript
// Frontend code - sequential requests, no parallelism
const wallet = new CashuWallet(mint);
await wallet.loadMint();

for (let i = 0; i < 100; i++) {
  const mintQuote = await wallet.createMintQuote(1);
  // Wait for payment
  const mintQuoteChecked = await wallet.checkMintQuote(mintQuote.quote);
  // Mint tokens
  const proofs = await wallet.mintProofs(1, mintQuote.quote);
  // Sometimes fails here with "Payment ID already exists"
}
```

## Expected Behavior

All 100 mint operations should succeed without errors when processing sequentially.

## Actual Behavior

Random failures with:
```
ERROR: Payment ID already exists: <payment_id>
ERROR: Could not check mint quote: Duplicate entry
Status code: 500 Internal Server Error
```

Typically fails around 10-50% of the time depending on system load.

## Root Cause Analysis

**Location**: `crates/cdk-sql-common/src/mint/mod.rs:744-760`

The function uses a check-then-act pattern with `SELECT ... FOR UPDATE`:

```rust
// Check if payment exists
let exists = query(
    "SELECT payment_id FROM mint_quote_payments
     WHERE payment_id = :payment_id FOR UPDATE"
).fetch_one().await?;

if exists.is_some() {
    return Err(Duplicate);
}

// Later... insert the payment
INSERT INTO mint_quote_payments (...) VALUES (...);
```

**The Problem**: `FOR UPDATE` only locks rows that exist. If the payment_id doesn't exist yet, there's nothing to lock, so concurrent transactions can both pass the check and try to insert.

**Why it happens with sequential requests**: Even though the client sends requests sequentially, the mint backend processes them concurrently with async tasks:

1. Request 1 arrives → spawns async task A
2. Request 2 arrives (50ms later) → spawns async task B
3. Task A: SELECT payment_id → not found
4. Task B: SELECT payment_id → not found (A hasn't inserted yet!)
5. Task A: INSERT payment_id → success
6. Task B: INSERT payment_id → **DUPLICATE ERROR** 💥

## Proposed Solution

Use the existing `UNIQUE` constraint on `mint_quote_payments.payment_id` to atomically reject duplicates:

```rust
// Try to insert - the UNIQUE constraint prevents duplicates atomically
let insert_result = query(
    "INSERT INTO mint_quote_payments (...) VALUES (...)"
).execute().await;

match insert_result {
    Ok(_) => Ok(new_amount_paid),
    Err(err) if err.to_string().contains("unique") => {
        // Rollback amount_paid update
        Err(database::Error::Duplicate)
    }
    Err(err) => Err(err),
}
```

This approach:
- ✅ Eliminates the race condition
- ✅ Better performance (one query instead of two)
- ✅ Works across all database clients
- ✅ Makes the operation idempotent

## Impact

**Severity**: High - Affects production deployments under load

**Affected Operations**:
- Sequential mint operations (as in our reproduction)
- High-frequency mint requests from multiple clients
- Any scenario where fakewallet or fast LN backends return payment confirmations quickly

## Additional Context

The database schema already has the UNIQUE constraint:
```sql
CREATE TABLE mint_quote_payments (
  id SERIAL PRIMARY KEY,
  quote_id TEXT NOT NULL,
  payment_id TEXT NOT NULL UNIQUE,  -- ← UNIQUE constraint exists
  ...
);
```

We should leverage this constraint instead of manually checking for duplicates.

## Proposed PR

I have a working fix that I can submit as a PR. Would the maintainers be interested in this contribution?

**Files to modify**:
- `crates/cdk-sql-common/src/mint/mod.rs` - Fix the race condition
- `crates/cdk-common/src/database/mint/test/mint.rs` - Add concurrent test case

Let me know if you'd like me to proceed with the PR!

## References

- [Database constraint as concurrency control](https://www.postgresql.org/docs/current/mvcc.html)
- [CDK database schema](https://github.com/cashubtc/cdk/blob/main/crates/cdk-sql-common/src/mint/migrations/postgres/1_initial.sql)
