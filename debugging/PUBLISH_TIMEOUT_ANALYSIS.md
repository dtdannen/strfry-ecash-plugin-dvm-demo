# Publish Timeout Analysis

## Problem
When running the ecash DVM performance test with 1000 requests, we see many "error: publish time out" messages in the console.

## Root Cause Analysis

### How `pool.publish()` Works
From nostr-tools documentation:
- `pool.publish(relays, event)` returns a **Promise**
- The promise resolves when the event is published to at least one relay
- The promise **rejects/times out** if it takes too long (default ~3-5 seconds)

### Current Ecash DVM Implementation
```typescript
// Line 406 in dvm-ecash-column.tsx
pool.publish([relayUrl], giftWrap)  // Fire-and-forget, no await, no .catch()
```

**What happens:**
1. `pool.publish()` is called but NOT awaited
2. Returns a Promise that's not handled
3. When the Promise times out, it creates an **unhandled Promise rejection**
4. Browser console shows: "error: publish time out"

### Encrypted DVM (no ecash) Implementation
```typescript
// Line 510 in page.tsx
poolRef.current.publish([relayUrl], giftWrap)  // Also fire-and-forget
```

**They have the SAME issue!** The encrypted DVM test also gets publish timeout errors.

## Why Both Tests Send All Events Before Receiving

This is **EXPECTED BEHAVIOR** and is the same for both tests:

### Sending Pattern
```typescript
for (let i = 0; i < count; i++) {
  // 1. Encrypt message (awaited)
  const { giftWrap } = await encryptNip17Message(...)

  // 2. Publish (fire-and-forget, NOT awaited)
  pool.publish([relayUrl], giftWrap)

  // 3. Add to tracking
  perfRequestsRef.current.push(newRequest)

  // 4. Small delay
  await new Promise(resolve => setTimeout(resolve, 10))
}
```

**Timeline for 1000 requests:**
- Total send time: 1000 × 10ms delay ≈ **10 seconds**
- Each publish takes 0-5ms to fire (async, not awaited)
- Responses come back from DVM as they're processed

### Receiving Pattern
Responses are received asynchronously via the subscription listener in useEffect (lines 455-580), which updates `perfRequestsRef.current` as responses arrive.

## Why Are We Seeing Timeout Errors?

When sending 1000 requests rapidly:
1. `pool.publish()` is called 1000 times over ~10 seconds
2. Each returns an unhandled Promise
3. The relay or network may not ACK all events quickly
4. Some Promises timeout (3-5 seconds default)
5. Unhandled Promise rejections appear in console

**This doesn't mean events aren't published!** It just means some ACKs took too long. The events likely still made it to the relay.

## Solutions

### Option 1: Silence the Errors (Recommended)
Add `.catch()` to suppress unhandled Promise rejections:

```typescript
pool.publish([relayUrl], giftWrap).catch(() => {})
```

**Pros:**
- Clean console output
- No functional change (events still published)
- Matches the intent (fire-and-forget)

**Cons:**
- Hides legitimate publish failures (but we don't care about them)

### Option 2: Await with Timeout Protection
Await the publish but don't let it block:

```typescript
pool.publish([relayUrl], giftWrap)
  .then(() => {}) // Success - ignore
  .catch(() => {}) // Timeout - ignore
```

This is functionally identical to Option 1.

### Option 3: Track Publish Success (Overkill)
Track which publishes succeeded vs timed out:

```typescript
const publishResult = await Promise.race([
  pool.publish([relayUrl], giftWrap),
  new Promise((_, reject) => setTimeout(() => reject('timeout'), 3000))
]).catch(() => 'failed')

if (publishResult === 'failed') {
  console.log(`Publish ${i} failed, but continuing...`)
}
```

**Pros:**
- Visibility into publish failures

**Cons:**
- More complex
- Slows down sending (blocks on each publish)
- Not needed since we care about responses, not ACKs

## Recommended Fix

**Add `.catch(() => {})` to both manual and performance test publish calls:**

```typescript
// Line 289 - Manual test
pool.publish([relayUrl], giftWrap).catch(() => {})

// Line 406 - Performance test
pool.publish([relayUrl], giftWrap).catch(() => {})
```

This silences the timeout errors while maintaining the fire-and-forget pattern that allows rapid sending.

## Why Both Tests Work Despite Timeouts

The timeout errors are **cosmetic** - they don't affect functionality because:

1. **Events are still published** - timeout just means relay didn't ACK in time
2. **We track responses, not publishes** - success is measured by receiving DVM responses
3. **The relay buffers events** - even if some ACKs are slow, events are processed
4. **Response listener is separate** - responses come back via subscription, independent of publish promises

## Comparison Summary

| Aspect | Encrypted DVM (no ecash) | Ecash DVM |
|--------|--------------------------|-----------|
| Relay | ws://localhost:7789 (port 7789) | ws://localhost:7788 (port 7788) |
| Plugin | None (plain strfry) | **Ecash validation plugin** |
| Publish pattern | `poolRef.current.publish()` | `pool.publish()` |
| Await? | No | No |
| Error handling | None | None |
| Timeout errors | **Possibly less** | **More frequent** |
| Functional impact | None | None |
| Send all before receive | Yes | Yes |
| Success rate | Based on responses | Based on responses |

## Critical Discovery: Different Relays!

The key difference is they use **different relays**:

- **Encrypted DVM**: `ws://localhost:7789` - Plain strfry relay
- **Ecash DVM**: `ws://localhost:7788` - Strfry WITH ecash plugin

### Why Ecash Relay Shows More Timeouts

The ecash relay (port 7788) is **slower to ACK** because of the `ecash_validator.py` plugin:

**Location**: `strfry/plugins/ecash_validator.py` (lines 241-289)

**How it works**:
1. Strfry receives incoming event via WebSocket
2. Strfry calls the plugin via stdin/stdout: `python3 /plugins/ecash_validator.py`
3. Plugin reads event from stdin (line 249)
4. Plugin validates ecash token:
   - Extract token from tags (line 209)
   - Call CDK mint at `http://cdk-mint:8096/v1/swap` (line 139)
   - Burn proofs via swap endpoint (lines 93-146)
   - Wait for HTTP response (timeout: 10 seconds, line 145)
5. Plugin writes "accept" or "reject" to stdout (line 262)
6. Strfry reads plugin response and ACKs to client

**The "queue" is actually**:
- **Strfry's single-threaded plugin execution**: Events are processed one-by-one through stdin/stdout
- **No explicit queue**: It's just sequential processing in the `for line in sys.stdin` loop (line 249)

**Why it's slow**:
1. **Synchronous processing**: Each event waits for the previous one to complete
2. **HTTP overhead**: Each validation requires:
   - GET `/v1/keys` to fetch keyset (~5-20ms)
   - POST `/v1/swap` to burn proofs (~30-150ms)
   - Total: 50-200ms per event
3. **With 1000 events**:
   - If 100ms average → 100 seconds total processing time
   - Events sent at 10ms intervals queue up faster than they can be validated
   - ACKs get delayed by 3-5+ seconds
   - `pool.publish()` promises timeout

**The actual queue**: Strfry's internal buffer of events waiting to be processed by the plugin

### Why Events Still Work

Despite timeouts, events ARE published successfully:
- Ecash relay logs show: `Inserted event. id=...` for all events
- The timeout is just the **ACK** taking >3-5 seconds
- Events are queued and processed eventually
- DVM responses come back as events are processed

**Conclusion:** The timeout errors are **cosmetic** and more frequent on ecash relay due to validation overhead. Events are successfully published and processed, just ACKed slower.
