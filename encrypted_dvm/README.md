# NIP-17 Encrypted Echo DVM

This directory contains a demonstration of a Data Vending Machine (DVM) that uses NIP-17 gift wrap encryption for complete end-to-end encryption between clients and DVMs.

## What is NIP-17?

[NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) specifies a protocol for encrypted direct messages using "gift wrap" encryption. This provides:

- **End-to-end encryption**: Only the sender and recipient can read the messages
- **Metadata privacy**: Random timestamps and ephemeral keys hide communication patterns
- **Forward secrecy**: Each message uses unique encryption keys
- **Anonymity**: The gift wrap sender appears random to observers

## How It Works

### Encryption Flow (Client → DVM)

1. **Create Message**: Client creates an unsigned job request event
2. **First Encryption**: Encrypt message with client's key → DVM's public key
3. **Create Seal**: Wrap encrypted message in a "seal" event (kind 13)
4. **Second Encryption**: Encrypt seal with random ephemeral key → DVM's public key
5. **Gift Wrap**: Create gift wrap event (kind 1059) signed by the same ephemeral key

### Decryption Flow (DVM)

1. **Receive Gift Wrap**: DVM receives kind 1059 event
2. **Decrypt Outer Layer**: Use DVM's private key to decrypt the seal
3. **Parse Seal**: Extract the seal event from decrypted JSON
4. **Decrypt Inner Layer**: Use DVM's private key to decrypt the original message
5. **Process Request**: Handle the decrypted job request

### Response Flow

The DVM sends responses using the same NIP-17 protocol in reverse, encrypting the response for the original sender.

## Architecture

```
encrypted_dvm/
├── encrypted_echo_dvm.py  # Main DVM implementation
├── nip17_crypto.py        # Shared NIP-17 crypto library
├── test_client.py         # Test client for debugging
├── Dockerfile             # Container configuration
├── requirements.txt       # Python dependencies
├── .env.example          # Example configuration
└── README.md             # This file
```

## Files

### `encrypted_echo_dvm.py`
The main DVM that:
- Listens for gift-wrapped job requests (kind 1059)
- Decrypts requests using NIP-17 protocol
- Processes echo jobs (returns the input)
- Sends gift-wrapped encrypted responses

### `nip17_crypto.py`
Shared library implementing NIP-17 encryption/decryption:
- `encrypt_nip17_message()`: Creates gift-wrapped encrypted messages
- `decrypt_nip17_gift_wrap()`: Decrypts gift-wrapped messages
- Handles all the complexity of the multi-layer encryption

### `test_client.py`
Standalone test client for debugging:
- Generates ephemeral keys
- Sends encrypted test messages
- Receives and decrypts responses
- Shows detailed encryption/decryption logs

## Running the Encrypted DVM

### With Docker Compose (Production)

The encrypted DVM runs as a separate service in the Docker Compose stack:

```bash
# Start all services including encrypted DVM
docker compose up

# Or just the encrypted DVM
docker compose up dvm-encrypted
```

The DVM will:
1. Generate keys on first run (stored in `/data/.env.encrypted`)
2. Display its npub for clients to use
3. Connect to the relay and start listening

### Local Testing (Development)

```bash
# Install dependencies
pip install nostr-sdk

# Run the DVM
python encrypted_echo_dvm.py

# In another terminal, run the test client
python test_client.py
```

## Configuration

### Environment Variables

- `RELAY_URL`: Relay to connect to (default: `ws://strfry:7777` in Docker)
- `DVM_NPUB`: The DVM's public key (auto-generated if not set)
- `DVM_SECRET_KEY`: The DVM's private key (auto-generated if not set)

### Persistent Keys

The DVM generates and stores keys in:
- Docker: `/data/.env.encrypted`
- Local: `./env`

This ensures the DVM maintains the same identity across restarts.

## Integration with Web UI

The web application can interact with this encrypted DVM by:

1. Getting the DVM's npub (shown on startup or from `.env.encrypted`)
2. Using NIP-17 to encrypt job requests
3. Sending gift-wrapped events (kind 1059)
4. Decrypting gift-wrapped responses

See `webapp/lib/nip17.ts` for the TypeScript implementation.

## Privacy Features

This implementation demonstrates several privacy features:

1. **Random Timestamps**: Events use random timestamps up to 2 days in the past
2. **Ephemeral Keys**: Gift wraps are signed by random keys
3. **No Correlation**: Observers cannot link requests to responses
4. **Metadata Protection**: Even relay operators cannot see the real participants

## Testing

### Quick Test

```bash
# Start the encrypted DVM
docker compose up dvm-encrypted

# Check the logs for the DVM npub
docker logs dvm-encrypted

# Run test client with the DVM npub
DVM_NPUB=npub1... python encrypted_dvm/test_client.py
```

### Test Messages

The test client sends several encrypted messages:
- "Hello, encrypted DVM!"
- "Can you echo this secret message?"
- "Testing NIP-17 encryption 🔐"
- "Final test message - encryption working great!"

Each message goes through the complete NIP-17 encryption flow.

## Comparison with Plain DVM

| Feature | Plain DVM | Encrypted DVM |
|---------|-----------|---------------|
| Event Kind | 25000 (plain) | 1059 (gift wrap) |
| Privacy | None | Complete E2E encryption |
| Metadata | Visible | Hidden |
| Performance | Faster | Slightly slower |
| Complexity | Simple | More complex |

## Security Considerations

1. **Key Management**: DVM keys should be kept secure
2. **Relay Trust**: Relays see encrypted traffic but cannot decrypt it
3. **Client Authentication**: Clients are identified by their public keys
4. **Forward Secrecy**: Each message uses unique ephemeral keys

## Debugging

Enable verbose logging by setting `verbose=True` in the crypto functions:

```python
# In encrypted_echo_dvm.py
job_event, real_sender = await decrypt_nip17_gift_wrap(
    recipient_keys=self.keys,
    gift_wrap_event=gift_wrap_event,
    verbose=True  # Enable detailed logs
)
```

## References

- [NIP-17 Specification](https://github.com/nostr-protocol/nips/blob/master/17.md)
- [NIP-44 Encryption](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [DVM Specification (NIP-90)](https://github.com/nostr-protocol/nips/blob/master/90.md)

## License

This is a demonstration/proof-of-concept implementation for educational purposes.