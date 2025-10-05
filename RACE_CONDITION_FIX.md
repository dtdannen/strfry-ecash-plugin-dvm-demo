# Race Condition Fix for CDK Mint

## Problem

The CDK mint has a race condition in `increment_mint_quote_amount_paid()` that causes "Payment ID already exists" errors even with sequential requests from a single client.

### Root Cause

**Location**: `cdk-sql-common/src/mint/mod.rs:744-760`

The function uses a classic check-then-act pattern:

```rust
// Check if payment exists
let exists = SELECT payment_id WHERE payment_id = :payment_id FOR UPDATE;
if exists.is_some() { return Err(Duplicate); }

// Later... insert payment
INSERT INTO mint_quote_payments (payment_id, ...) VALUES (...);
```

The `FOR UPDATE` lock only locks rows that **already exist**. If the payment_id doesn't exist yet, both concurrent requests pass the check and try to insert, causing a duplicate key violation.

### Why It Happens With Sequential Requests

Even when the frontend sends requests one at a time, the CDK mint backend processes them **concurrently with async tasks**:

1. Request 1 arrives → spawns async task A
2. Request 2 arrives → spawns async task B
3. Task A: SELECT payment_id → not found
4. Task B: SELECT payment_id → not found (A hasn't inserted yet!)
5. Task A: INSERT payment_id → success
6. Task B: INSERT payment_id → **DUPLICATE ERROR** 💥

## Solution

Use the existing `UNIQUE` constraint on `mint_quote_payments.payment_id` to atomically reject duplicates:

```rust
// Try to insert - the UNIQUE constraint prevents duplicates atomically
let insert_result = INSERT INTO mint_quote_payments (...) VALUES (...);

match insert_result {
    Ok(_) => Ok(new_amount_paid),
    Err(err) if err.contains("unique") => Err(Duplicate),
    Err(err) => Err(err),
}
```

This fix:
- ✅ Eliminates the race condition
- ✅ Better performance (one query instead of two)
- ✅ Works across all database clients
- ✅ Makes the operation idempotent

## Testing

To reproduce the race condition:

1. Run the webapp performance test: "Mint 100 Tokens"
2. Or rapidly click "Mint 1 Sat" button multiple times
3. Observe "Payment ID already exists" errors in logs

With the fix applied, these errors should no longer occur.

## Files Changed

- `cdk/crates/cdk-sql-common/src/mint/mod.rs` - Fixed `increment_mint_quote_amount_paid()` function

## Next Steps

1. ✅ Fix implemented and tested locally
2. Create comprehensive test case
3. Submit PR to cashubtc/cdk repository
4. Update CHANGELOG.md
