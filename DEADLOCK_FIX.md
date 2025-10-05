# PostgreSQL Deadlock Fix

## Problem

After fixing the initial race condition, we encountered PostgreSQL deadlock errors when testing with 100 concurrent token mints:

```
ERROR: deadlock detected
DETAIL: Process 40 waits for ShareLock on transaction 2013; blocked by process 48.
Process 48 waits for ShareLock on transaction 2014; blocked by process 40.
CONTEXT: while locking tuple (19,25) in relation "mint_quote"
SQL statement "SELECT 1 FROM ONLY "public"."mint_quote" x WHERE "id" OPERATOR(pg_catalog.=) $1 FOR KEY SHARE OF x"
STATEMENT: INSERT INTO mint_quote_payments (quote_id, payment_id, amount, timestamp) VALUES ( $1 , $2 , $3 , $4 )
```

## Root Cause Analysis

### The Foreign Key Lock Problem

The `mint_quote_payments` table has a foreign key constraint:

```sql
FOREIGN KEY (quote_id) REFERENCES mint_quote(id)
```

When PostgreSQL executes an INSERT into `mint_quote_payments`, it:
1. Checks the foreign key constraint
2. Acquires a `FOR KEY SHARE` lock on the referenced row in `mint_quote`
3. This lock prevents the referenced row from being deleted/updated while the FK check happens

### How the Deadlock Occurs

With 100 concurrent mint operations for the same quote:

```
Time  | Process A                          | Process B
------|------------------------------------|---------------------------------
T1    | BEGIN TRANSACTION                  | BEGIN TRANSACTION
T2    | INSERT INTO mint_quote_payments    |
      | → Acquires FOR KEY SHARE lock      |
      |   on mint_quote row                |
T3    |                                    | INSERT INTO mint_quote_payments
      |                                    | → Waits for lock on mint_quote
T4    | Tries to upgrade to exclusive lock |
      | → Waits for Process B              |
T5    | DEADLOCK DETECTED! 💥              | DEADLOCK DETECTED! 💥
```

The circular wait happens because:
- Process A holds a `FOR KEY SHARE` lock and needs an exclusive lock
- Process B is waiting for the `FOR KEY SHARE` lock that A holds
- Neither can proceed → deadlock

## Solution: Explicit Lock Ordering

**Key Principle**: Prevent deadlocks by ensuring all transactions acquire locks in the same order.

### Implementation

```rust
async fn increment_mint_quote_amount_paid(
    &mut self,
    quote_id: &QuoteId,
    amount_paid: Amount,
    payment_id: String,
) -> Result<Amount, Self::Err> {
    // Step 1: Lock the mint_quote row FIRST to prevent deadlocks
    // This establishes a consistent lock ordering across all transactions
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
    // The UNIQUE constraint on payment_id prevents duplicates atomically
    let insert_result = query(
        r#"
        INSERT INTO mint_quote_payments
        (quote_id, payment_id, amount, timestamp)
        VALUES (:quote_id, :payment_id, :amount, :timestamp)
        "#,
    )?
    .bind("quote_id", quote_id.to_string())
    .bind("payment_id", payment_id.clone())
    .bind("amount", amount_paid.to_i64())
    .bind("timestamp", unix_time() as i64)
    .execute(&self.inner)
    .await;

    // Step 3: Handle duplicate gracefully
    match insert_result {
        Ok(_) => { /* Continue to update */ }
        Err(err) if err.contains("unique") => return Err(Duplicate),
        Err(err) => return Err(err),
    }

    // Step 4: Calculate and update amount_paid
    let new_amount_paid = current_amount_paid.checked_add(amount_paid)?;

    query(
        r#"
        UPDATE mint_quote
        SET amount_paid = :amount_paid
        WHERE id = :quote_id
        "#,
    )?
    .bind("amount_paid", new_amount_paid.to_i64())
    .bind("quote_id", quote_id.to_string())
    .execute(&self.inner)
    .await?;

    Ok(new_amount_paid)
}
```

### Why This Works

1. **Consistent Lock Ordering**: All transactions now follow the same sequence:
   - Lock `mint_quote` row first (FOR UPDATE)
   - Then insert into `mint_quote_payments`

2. **FOR UPDATE is Exclusive**: The `FOR UPDATE` lock is stronger than `FOR KEY SHARE`:
   - Only one transaction can hold it at a time
   - Subsequent transactions queue up waiting for it
   - No circular waits = no deadlocks

3. **Transaction Serialization**: With the explicit lock:
   ```
   Time  | Process A                     | Process B
   ------|-------------------------------|--------------------------------
   T1    | FOR UPDATE mint_quote row     |
         | → Acquired                    |
   T2    |                               | FOR UPDATE mint_quote row
         |                               | → Waiting (Process A has lock)
   T3    | INSERT mint_quote_payments    |
         | → Success                     |
   T4    | UPDATE mint_quote             |
         | → Success                     |
   T5    | COMMIT (releases lock)        |
   T6    |                               | → Lock acquired, can proceed
   ```

## Benefits

✅ **Eliminates deadlocks** - Consistent lock ordering prevents circular waits
✅ **Still prevents race conditions** - UNIQUE constraint on payment_id works atomically
✅ **Maintains data integrity** - All FK constraints are still enforced
✅ **Handles high concurrency** - Safely processes 100+ concurrent operations
✅ **Idempotent operations** - Duplicate payment_ids are handled gracefully

## Testing

To verify the fix works:

```bash
# Rebuild with the fix
docker compose build cdk-mint

# Start services
docker compose up

# Test with webapp at http://localhost:3000
# Use slider to select 100 tokens
# Click "Mint 100 Tokens"
# Should complete without deadlock errors
```

## Files Changed

- `cdk/crates/cdk-sql-common/src/mint/mod.rs:732-831` - Fixed lock ordering in `increment_mint_quote_amount_paid()`

## Related Issues

This deadlock was discovered after fixing the initial race condition documented in:
- [RACE_CONDITION_FIX.md](./RACE_CONDITION_FIX.md)
- [RACE_CONDITION_SUMMARY.md](./RACE_CONDITION_SUMMARY.md)

Both fixes are needed for robust concurrent payment processing.
