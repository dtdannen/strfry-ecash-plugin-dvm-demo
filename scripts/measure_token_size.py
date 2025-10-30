#!/usr/bin/env python3
"""
Script to measure the size of an ecash token.
Shows the typical size of a Cashu ecash token at different layers.
"""

import json

print("=" * 70)
print("ECASH TOKEN SIZE ANALYSIS")
print("=" * 70)
print()

# Based on Cashu TokenV4 structure analysis
print("A Cashu ecash token consists of cryptographic proofs.")
print("Each proof contains:")
print("  - Keyset ID (16 hex characters)")
print("  - Amount (integer, e.g., 1 sat)")
print("  - Secret (random 32-byte value, base64-encoded)")
print("  - C (compressed pubkey, 33 bytes as 66 hex characters)")
print()

# Sample proof structure
sample_proof = {
    "id": "001b6c716bf42c7e",
    "amount": 1,
    "secret": "a" * 43,  # base64-encoded 32 bytes
    "C": "02" + "0" * 62  # compressed pubkey
}

proof_json_str = json.dumps(sample_proof)
proof_size = len(proof_json_str.encode('utf-8'))

print("=" * 70)
print("SIZE BREAKDOWN FOR A 1-SAT TOKEN:")
print("=" * 70)
print()
print(f"1. Single Proof (JSON):")
print(f"   {proof_json_str}")
print(f"   Size: {proof_size} bytes")
print()

# Cashu uses TokenV4 format: CBOR-encoded and base64url-encoded
# Typical overhead for CBOR + base64: ~40-50%
serialized_estimate = int(proof_size * 1.45)
print(f"2. Serialized Token (cashuB + base64url-encoded CBOR):")
print(f"   Format: cashuB<base64url-encoded-data>")
print(f"   Estimated size: ~{serialized_estimate} bytes")
print()

# With JSON wrapper (as used in Nostr tags)
token_placeholder = "cashuB" + "x" * (serialized_estimate - 6)
wrapped = {
    "token": token_placeholder,
    "amount": 1,
    "mint": "http://localhost:8096",
    "unit": "sat"
}
wrapped_size = len(json.dumps(wrapped).encode('utf-8'))

print(f"3. Token with JSON Metadata (as used in Nostr events):")
print(f"   {{")
print(f'     "token": "cashuB...",')
print(f'     "amount": 1,')
print(f'     "mint": "http://localhost:8096",')
print(f'     "unit": "sat"')
print(f"   }}")
print(f"   Estimated size: ~{wrapped_size} bytes")
print()

print("=" * 70)
print("SUMMARY:")
print("=" * 70)
print()
print(f"For a 1-sat ecash token:")
print(f"  • Raw proof (JSON):          ~{proof_size} bytes")
print(f"  • Serialized token string:   ~{serialized_estimate} bytes")
print(f"  • With JSON metadata:        ~{wrapped_size} bytes")
print()
print("Key insights:")
print(f"  • The token itself is ~{serialized_estimate} bytes (just the cashuB string)")
print(f"  • When wrapped with metadata for Nostr, add ~{wrapped_size - serialized_estimate} bytes")
print(f"  • Total overhead in a Nostr event: ~{wrapped_size} bytes per payment")
print()

print("=" * 70)
print("MULTI-AMOUNT COMPARISON:")
print("=" * 70)
print()
print("Tokens for larger amounts may use multiple proofs (denominations):")
print(f"{'Amount':<15} {'Proofs':<10} {'Token Size (approx)':<25}")
print("-" * 70)

for amount, num_proofs in [(1, 1), (10, 2), (100, 2), (1000, 3)]:
    token_size_est = num_proofs * serialized_estimate
    print(f"{amount:<15} {num_proofs:<10} ~{token_size_est} bytes")

print()
print("Note: Actual sizes may vary by ±20% depending on the specific")
print("      keyset, mint URL length, and encoding efficiency.")
print()
