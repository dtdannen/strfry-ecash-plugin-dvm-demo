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

## Update: Deadlock Issue & Fix

### New Problem Discovered

After implementing the initial fix (INSERT first, then UPDATE), we encountered a PostgreSQL deadlock when testing with 100 concurrent tokens:

```
ERROR: deadlock detected
DETAIL: Process 40 waits for ShareLock on transaction 2013; blocked by process 48.
Process 48 waits for ShareLock on transaction 2014; blocked by process 40.
CONTEXT: while locking tuple (19,25) in relation "mint_quote"
```

**Root Cause**: The foreign key constraint `FOREIGN KEY (quote_id) REFERENCES mint_quote(id)` on `mint_quote_payments` table causes PostgreSQL to acquire a `FOR KEY SHARE` lock on the referenced `mint_quote` row during INSERT. With many concurrent insertions for the same quote, this created circular wait conditions.

### Deadlock Fix

**Solution**: Acquire an explicit `FOR UPDATE` lock on the `mint_quote` row **before** doing the INSERT. This establishes a consistent lock ordering across all transactions:

```rust
// Step 1: Lock the mint_quote row FIRST to prevent deadlocks
let current_amount = query(
    r#"
    SELECT amount_paid
    FROM mint_quote
    WHERE id = :quote_id
    FOR UPDATE
    "#,
)?
.bind("quote_id", quote_id.to_string())
.fetch_one(&self.inner)
.await?;

// Step 2: Try to insert payment_id - fail fast on duplicates
let insert_result = query(
    r#"
    INSERT INTO mint_quote_payments
    (quote_id, payment_id, amount, timestamp)
    VALUES (:quote_id, :payment_id, :amount, :timestamp)
    "#,
)?
.execute(&self.inner)
.await;

// Step 3: Handle duplicate gracefully
match insert_result {
    Ok(_) => { /* update amount */ }
    Err(err) if err.contains("unique") => return Err(Duplicate),
    Err(err) => return Err(err),
}

// Step 4: Update amount_paid
```

**Why This Works**:
- All transactions acquire locks in the same order: `mint_quote` row first, then `mint_quote_payments` insert
- Prevents circular wait conditions that cause deadlocks
- The `FOR UPDATE` lock is stronger than the `FOR KEY SHARE` lock acquired by the FK constraint
- No circular dependencies = no deadlocks

### Final Operation Order

The complete fix now has this sequence:

1. **Lock** the `mint_quote` row (`FOR UPDATE`)
2. **Insert** payment into `mint_quote_payments` (fails fast on duplicate `payment_id`)
3. **Update** `amount_paid` in `mint_quote`

This ordering:
- ✅ Prevents race conditions (atomic duplicate check via UNIQUE constraint)
- ✅ Prevents deadlocks (consistent lock ordering)
- ✅ Maintains data integrity (FK constraints enforced)
- ✅ Handles duplicates gracefully (idempotent operations)

## Next Steps

1. ✅ Fix implemented and tested locally
2. ✅ Deadlock issue identified and fixed
3. Create comprehensive test case
4. Submit PR to cashubtc/cdk repository
5. Update CHANGELOG.md
