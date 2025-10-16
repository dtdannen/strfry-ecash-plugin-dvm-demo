# Ecash Features Implementation

## Overview
This document describes the ecash payment system integrated into the strfry relay and DVM ecosystem. The system requires ecash payments for both relay access and DVM processing.

## Components

### 1. Strfry Ecash Validation Plugin
**Location:** `/strfry/plugins/ecash_validator.py`

- **Purpose:** Validates ecash tokens for all events submitted to the relay
- **Features:**
  - Accepts events with valid ecash tokens in tags or content
  - Rejects events without tokens or with invalid/spent tokens
  - Always validates with mint (no caching) for accurate benchmarking
  - Logs validation times for performance analysis
  - Supports both cashuA (V3) and cashuB (V4) token formats

- **Configuration:**
  - Mint URL: `http://cdk-mint:8096`
  - Required amount: 1 sat minimum
  - Plugin path configured in `strfry.conf`

### 2. Encrypted Ecash DVM
**Location:** `/encrypted_ecash_dvm/`

- **Purpose:** NIP-17 encrypted DVM that requires ecash payment for processing
- **Features:**
  - Accepts encrypted requests with ecash tokens
  - Validates tokens before processing
  - Tracks earnings and statistics
  - Sends heartbeats with payment stats
  - Supports configurable pricing

- **Files:**
  - `encrypted_ecash_echo_dvm.py` - Main DVM implementation
  - `nip17_crypto.py` - NIP-17 encryption/decryption
  - `requirements.txt` - Python dependencies
  - `Dockerfile` - Container configuration

### 3. Web Application Updates
**Location:** `/webapp/app/dvm-tester/`

- **New Component:** `dvm-ecash-column.tsx`
  - Third column in DVM tester for encrypted ecash DVM
  - Automatic token minting before requests
  - Performance testing up to 10,000 tokens
  - Batch processing for large-scale tests
  - Real-time progress tracking
  - Comprehensive metrics display

- **Features:**
  - Manual testing with single token payments
  - Performance testing with configurable token counts (10, 100, 1k, 10k)
  - Batch minting and sending for efficiency
  - Response time tracking
  - Success rate calculation
  - Total cost display

### 4. Docker Configuration
**Updates to `docker-compose.yml`:**

- **New Service:** `dvm-encrypted-ecash`
  - Container: `dvm-encrypted-ecash`
  - Environment variables:
    - `RELAY_URL=ws://strfry:7777`
    - `MINT_URL=http://cdk-mint:8096`
    - `REQUIRED_SATS=1`
  - Volume: `dvm-encrypted-ecash-data` for key persistence

- **Strfry Updates:**
  - Python 3 and pip installed
  - Cashu library for token validation
  - Plugin mounted and configured

## Token Flow

### Relay Access Flow
1. Client mints ecash token from CDK mint
2. Client creates Nostr event with token in `["ecash", "<token>"]` tag
3. Client sends event to relay
4. Strfry plugin validates token with mint
5. If valid, event is accepted; if invalid, rejected with NIP-20 message

### Encrypted Ecash DVM Flow
1. Client mints token(s) from CDK mint
2. Client creates DVM request with token
3. Client encrypts request using NIP-17
4. Client sends encrypted request to relay
5. Relay validates token (first validation)
6. DVM receives encrypted request
7. DVM decrypts and extracts token
8. DVM validates token with mint (second validation)
9. If valid, DVM processes request
10. DVM sends encrypted response
11. Client receives and decrypts response

## Performance Testing

### Test Configurations
- **10 tokens:** Basic functionality test
- **100 tokens:** Small batch performance
- **1,000 tokens:** Medium scale benchmark
- **10,000 tokens:** Large scale stress test

### Metrics Tracked
- Token minting time
- Request sending time
- Relay validation latency
- DVM processing time
- End-to-end response time
- Success/failure rates
- Average response times
- Total earnings (DVM)

### Batching Strategy
- Tokens minted in batches of 100 to avoid overwhelming mint
- Requests sent in batches with 100ms delay between batches
- Progress tracking for both minting and sending phases

## Testing Tools

### Test Script
**Location:** `/test_ecash_plugin.py`

Tests three scenarios:
1. Valid token - should be accepted
2. No token - should be rejected
3. Spent token - should be rejected

### Manual Testing via Web UI
1. Navigate to http://localhost:3011/dvm-tester
2. Third column shows "Encrypted Ecash DVM"
3. Enter message and click "Send Ecash Request"
4. Token is automatically minted and included
5. Response shows payment validation and echo result

### Performance Benchmarking
1. Select number of tokens (10, 100, 1k, 10k)
2. Click "Run Performance Test"
3. Watch progress bars for minting and sending
4. View comprehensive metrics after completion

## Configuration

### Environment Variables
- `MINT_URL`: CDK mint URL (default: http://cdk-mint:8096)
- `REQUIRED_SATS`: Minimum payment required (default: 1)
- `RELAY_URL`: Strfry relay WebSocket URL

### Pricing
- Relay access: 1 sat per event
- DVM processing: 1 sat per request
- Configurable via environment variables

## Monitoring

### Logs
- Strfry plugin: `/tmp/ecash_validator.log`
- DVM stats: Logged every 60 seconds
- Validation times: Tracked for benchmarking

### Heartbeats
- Encrypted ecash DVM sends heartbeats every 10 seconds
- Includes:
  - Total requests
  - Valid/invalid payments
  - Total earnings
  - Unique users

## Security Considerations

### Double-Spend Prevention
- Tokens are immediately spent upon validation
- CDK mint tracks spent tokens
- No token caching (for accurate benchmarking)

### Privacy
- NIP-17 encryption for DVM requests/responses
- Ephemeral keys for gift wrapping
- Random timestamps for metadata protection

## Future Enhancements

### Planned Improvements
1. **Rust/Go Plugin:** Port Python plugin for better performance
2. **Dynamic Pricing:** Adjust costs based on request complexity
3. **Token Refunds:** Return tokens for failed processing
4. **Batch Validation:** Optimize for high-volume scenarios
5. **Connection Pooling:** Improve mint connection efficiency

### Benchmarking Goals
- Measure mint performance under load
- Compare Python vs Rust plugin performance
- Analyze database query optimization
- Track network latency impacts

## Troubleshooting

### Common Issues

1. **Plugin not accepting events:**
   - Check mint is running: http://localhost:8096
   - Verify token format (cashuA or cashuB prefix)
   - Check plugin logs: `/tmp/ecash_validator.log`

2. **DVM not responding:**
   - Verify DVM container is running
   - Check heartbeat in web UI
   - Ensure public key is available

3. **Token validation failures:**
   - Tokens may be already spent
   - Mint may be unavailable
   - Network connectivity issues

### Debug Commands
```bash
# Check plugin logs
docker exec strfry-relay cat /tmp/ecash_validator.log

# View DVM logs
docker logs dvm-encrypted-ecash

# Test mint directly
curl http://localhost:8096/v1/info

# Monitor relay events
docker logs strfry-relay -f
```

## Conclusion

This implementation provides a complete ecash payment system for both relay access and DVM processing. The system is designed for benchmarking mint performance under various load conditions while maintaining security and privacy through encryption.