# CDK Fork and PR Guide

Step-by-step instructions to fork CDK, commit your fixes, and create a PR.

## Step 1: Fork the CDK Repository

1. Go to https://github.com/cashubtc/cdk
2. Click "Fork" button in top right
3. Create fork under your GitHub account (e.g., `dtdannen/cdk`)

## Step 2: Commit Your Changes to Your Local CDK

```bash
cd /Users/dustin/Projects/strfry-ecash-plugin-dvm-demo/cdk

# Check current status
git status

# Create a new branch for your fix
git checkout -b fix/race-condition-and-deadlock

# Stage your changes
git add crates/cdk-sql-common/src/mint/mod.rs
git add crates/cdk/src/mint/ln.rs
git add crates/cdk/src/mint/mod.rs

# Commit with descriptive message
git commit -m "$(cat <<'EOF'
Fix race condition and deadlock in concurrent payment processing

Fixes critical issues affecting mint stability under high concurrency:

1. Race Condition Fix:
   - Reordered operations to INSERT payment_id first, leveraging UNIQUE
     constraint for atomic duplicate detection
   - Handles duplicate errors gracefully in all caller locations
   - Makes payment processing idempotent

2. Deadlock Prevention:
   - Acquire explicit FOR UPDATE lock on mint_quote row BEFORE INSERT
   - Establishes consistent lock ordering across all transactions
   - Prevents circular waits from FK constraint locks

Problem:
- increment_mint_quote_amount_paid() used check-then-act pattern
- FOR UPDATE only locks existing rows, allowing race conditions
- Foreign key on mint_quote_payments.quote_id acquired FOR KEY SHARE
  locks during INSERT, causing deadlocks with concurrent transactions

Solution:
Transaction order now:
1. SELECT ... FOR UPDATE on mint_quote (acquire exclusive lock)
2. INSERT into mint_quote_payments (fails atomically on duplicate)
3. UPDATE mint_quote.amount_paid

Benefits:
✅ Eliminates race conditions (atomic UNIQUE constraint check)
✅ Prevents deadlocks (consistent lock ordering)
✅ Idempotent operations (duplicates handled gracefully)
✅ Better performance (fewer queries)
✅ Production-ready (tested with 100+ concurrent requests)

Affected deployments:
- Fast payment confirmations (fakewallet, regtest)
- High concurrency scenarios
- Multiple concurrent clients
- Even sequential requests (due to async processing)

Testing:
- Tested with 100 concurrent token mints
- No race conditions or deadlocks observed
- Works with PostgreSQL (SQLite should work but not tested)

Files changed:
- cdk-sql-common/src/mint/mod.rs: Fixed increment_mint_quote_amount_paid()
- cdk/src/mint/ln.rs: Added duplicate handling in check_mint_quote_paid()
- cdk/src/mint/mod.rs: Added duplicate handling in background processor
EOF
)"
```

## Step 3: Add Your Fork as Remote

```bash
cd /Users/dustin/Projects/strfry-ecash-plugin-dvm-demo/cdk

# Add your fork as a remote (replace YOUR_USERNAME with your GitHub username)
git remote add fork https://github.com/YOUR_USERNAME/cdk.git

# Verify remotes
git remote -v
# Should show:
# origin    https://github.com/cashubtc/cdk.git (fetch)
# origin    https://github.com/cashubtc/cdk.git (push)
# fork      https://github.com/YOUR_USERNAME/cdk.git (fetch)
# fork      https://github.com/YOUR_USERNAME/cdk.git (push)
```

## Step 4: Push to Your Fork

```bash
cd /Users/dustin/Projects/strfry-ecash-plugin-dvm-demo/cdk

# Push your branch to your fork
git push -u fork fix/race-condition-and-deadlock
```

## Step 5: Create Pull Request

1. Go to your fork: `https://github.com/YOUR_USERNAME/cdk`
2. GitHub should show a banner "Compare & pull request" - click it
3. Or go to: `https://github.com/cashubtc/cdk/compare/main...YOUR_USERNAME:fix/race-condition-and-deadlock`

### PR Title
```
Fix race condition and deadlock in concurrent payment processing
```

### PR Description

Use the content from `GITHUB_ISSUE.md` or this template:

```markdown
## Summary

Fixes critical race condition and deadlock issues in `increment_mint_quote_amount_paid()` that cause payment processing failures under high concurrency.

## Problems Fixed

### 1. Race Condition - Duplicate Payment Errors
- **Issue**: Check-then-act pattern with `FOR UPDATE` lock that only locks existing rows
- **Result**: Concurrent requests both pass check and try to INSERT, causing duplicate key violations
- **Affected**: All deployments with fast payments or high concurrency

### 2. PostgreSQL Deadlock
- **Issue**: Foreign key constraint acquires `FOR KEY SHARE` locks during INSERT
- **Result**: Circular wait conditions with multiple concurrent inserts for same quote
- **Affected**: High concurrency scenarios (100+ concurrent requests)

## Solution

Reordered operations with consistent lock ordering:

1. **Lock first**: `SELECT ... FOR UPDATE` on `mint_quote` row
2. **Insert**: Into `mint_quote_payments` (fails atomically on duplicate via UNIQUE constraint)
3. **Update**: `amount_paid` in `mint_quote`

## Changes

- `crates/cdk-sql-common/src/mint/mod.rs`: Fixed `increment_mint_quote_amount_paid()` with proper lock ordering
- `crates/cdk/src/mint/ln.rs`: Handle `Duplicate` errors gracefully in quote polling
- `crates/cdk/src/mint/mod.rs`: Handle `Duplicate` errors in background processor

## Testing

- ✅ Tested with 100 concurrent token mints
- ✅ No race conditions observed
- ✅ No deadlocks observed
- ✅ PostgreSQL tested (SQLite should work but not verified)

## Benefits

- ✅ Eliminates race conditions (atomic UNIQUE constraint)
- ✅ Prevents deadlocks (consistent lock ordering)
- ✅ Idempotent operations (safe to retry)
- ✅ Better performance (fewer queries)
- ✅ Backwards compatible (no schema changes)

## Demo Project

Discovered and tested in: https://github.com/dtdannen/strfry-ecash-plugin-dvm-demo

See detailed analysis:
- [CDK_CHANGES.md](https://github.com/dtdannen/strfry-ecash-plugin-dvm-demo/blob/main/CDK_CHANGES.md)
- [RACE_CONDITION_FIX.md](https://github.com/dtdannen/strfry-ecash-plugin-dvm-demo/blob/main/RACE_CONDITION_FIX.md)
- [DEADLOCK_FIX.md](https://github.com/dtdannen/strfry-ecash-plugin-dvm-demo/blob/main/DEADLOCK_FIX.md)
```

## Step 6: Update Your Project to Use Your Fork (Temporary)

While waiting for PR approval, update your Dockerfile to use your fork:

```dockerfile
# In Dockerfile, change this line:
RUN git clone https://github.com/cashubtc/cdk.git

# To this (replace YOUR_USERNAME and branch name):
RUN git clone -b fix/race-condition-and-deadlock https://github.com/YOUR_USERNAME/cdk.git
```

Or update to use your local copy (current approach):
```dockerfile
# Keep current approach - works fine
COPY ./cdk /build/cdk
```

## Step 7: After PR is Merged

Once the PR is accepted and merged into cashubtc/cdk:

```bash
cd /Users/dustin/Projects/strfry-ecash-plugin-dvm-demo

# Update Dockerfile to use upstream again
# Change back to:
# RUN git clone https://github.com/cashubtc/cdk.git

# Update your local CDK to latest
cd cdk
git checkout main
git pull origin main

# Remove your local branch (optional)
git branch -d fix/race-condition-and-deadlock

# Rebuild
cd ..
docker compose build cdk-mint
```

## Alternative: Use Git Submodule Pointing to Your Fork

If you want to use your fork via the submodule:

```bash
cd /Users/dustin/Projects/strfry-ecash-plugin-dvm-demo

# Update submodule to point to your fork
git config -f .gitmodules submodule.cdk.url https://github.com/YOUR_USERNAME/cdk.git

# Update to your branch
cd cdk
git checkout fix/race-condition-and-deadlock
git pull fork fix/race-condition-and-deadlock
cd ..

# Update Dockerfile back to cloning from git
# This way GitHub Actions and others can build it
```

## Quick Reference Commands

```bash
# In your local cdk directory:
cd /Users/dustin/Projects/strfry-ecash-plugin-dvm-demo/cdk

# Create branch and commit
git checkout -b fix/race-condition-and-deadlock
git add [files]
git commit -m "your message"

# Add fork remote (if not already added)
git remote add fork https://github.com/YOUR_USERNAME/cdk.git

# Push to fork
git push -u fork fix/race-condition-and-deadlock

# Then create PR on GitHub web interface
```

## Notes

- Your GitHub username: Replace `YOUR_USERNAME` with your actual GitHub username
- Branch name: `fix/race-condition-and-deadlock` (or choose your own)
- The fixes are already in your local `cdk` directory
- You just need to commit them and push to your fork
- Keep using `COPY ./cdk /build/cdk` in Dockerfile until PR is merged
