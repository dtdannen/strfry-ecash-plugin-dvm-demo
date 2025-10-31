# Performance Issues and Solutions

## SQLite Concurrency Issue (Discovered: 2025-10-01)

### Problem Description

During performance testing of the CDK mint with 10,000 sequential mint operations, we encountered database concurrency issues with the default SQLite backend.

### Symptoms

1. **"Payment ID already exists" error:**
   ```
   ERROR: Payment ID already exists: 7ea9006a89da89ce6523f49e8bdf6d96d51d050dd6412e6528ac509dc3643ec7
   ERROR: Could not check mint quote: Duplicate entry
   Status code: 500 Internal Server Error
   ```

2. **Slow query warnings:**
   - Query times ranging from 20ms to 1225ms
   - Most common slow operations:
     - `COMMIT` transactions (21ms - 1225ms)
     - `INSERT INTO mint_quote` (37ms - 755ms)
     - `SELECT ... FOR UPDATE` (29ms - 97ms)
     - `UPDATE mint_quote SET amount_paid` (1089ms)

### Root Cause

**SQLite Architecture Limitation:**
- SQLite uses file-level locking, allowing only one writer at a time
- Under high concurrent load, write transactions queue up causing lock contention
- The mint's payment tracking has race conditions where multiple threads check for payment ID existence simultaneously, then both try to insert, causing duplicate key errors

**Race Condition Flow:**
1. Thread A checks if payment ID exists → not found
2. Thread B checks if payment ID exists → not found
3. Thread A inserts payment ID → success
4. Thread B tries to insert same payment ID → **ERROR: duplicate**

### Test Configuration

- **Mint backend:** fakewallet (instant confirmations, no natural delays)
- **Database:** SQLite (default)
- **Test pattern:** 10,000 sequential mint operations as fast as possible
- **Client delay:** Initially 0ms, then 5ms between operations

### Attempted Solutions

#### 1. Added 5ms client-side delay (Partial success)
- **Location:** `webapp/app/page.tsx` - added delay after each mint/spend operation
- **Result:** Significantly reduced errors, but slow queries and occasional "Payment ID already exists" errors persisted
- **Observation:** Got much further in the test (near completion) before hitting errors

### Recommended Solution

**Migrate to PostgreSQL:**
- PostgreSQL has row-level locking instead of file-level locking
- Better handling of concurrent write operations
- More mature transaction isolation mechanisms
- Better suited for production workloads with concurrent users

### Implementation

See `docker-compose.yml` and `config.toml` for PostgreSQL configuration.

### Notes for Production

This issue reveals real-world scalability concerns:
- Popular mints will experience concurrent user requests
- While real Lightning payments have natural network delays that space out operations, busy mints still need robust database concurrency handling
- The fakewallet backend removes all natural rate-limiting, making this test a realistic stress test scenario
- PostgreSQL is recommended for any production deployment

### Performance Expectations

With PostgreSQL, we expect:
- Elimination of "Payment ID already exists" errors
- More consistent query performance
- Better handling of concurrent operations
- Ability to handle higher transaction volumes

### Related Files

- `webapp/app/page.tsx` - Performance testing implementation with 5ms delays
- `config.toml` - Database configuration
- `docker-compose.yml` - Database service configuration
