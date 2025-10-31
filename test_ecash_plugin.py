#!/usr/bin/env python3
"""
Test script for the ecash plugin.
Tests sending an event with an ecash token to the relay.
"""

import asyncio
import json
import time
from nostr_sdk import Client, EventBuilder, Keys, Tag
from cashu.wallet.wallet import Wallet
from cashu.core.base import TokenV4

MINT_URL = "http://localhost:8096"
RELAY_URL = "ws://localhost:7788"

async def mint_token(amount: int = 1):
    """Mint a test token"""
    wallet = Wallet(MINT_URL)
    await wallet.load_mint()

    # Create mint quote
    quote = await wallet.create_mint_quote(amount)

    # Check payment (fakewallet auto-pays)
    await wallet.check_mint_quote(quote.quote)

    # Mint proofs
    proofs_response = await wallet.mintProofs(amount, quote.quote)

    # Create token
    from cashu.core.base import TokenV4
    token = TokenV4.from_proofs(proofs_response.proofs, MINT_URL)

    return token.serialize()

async def test_with_token():
    """Test sending an event with a valid ecash token"""
    print("Testing with valid ecash token...")

    # Mint a token
    token = await mint_token(1)
    print(f"Minted token: {token[:50]}...")

    # Create client
    keys = Keys.generate()
    client = Client(keys)

    # Connect to relay
    await client.add_relay(RELAY_URL)
    await client.connect()
    print(f"Connected to relay: {RELAY_URL}")

    # Create event with ecash token
    event = (
        EventBuilder.text_note("Test event with ecash payment")
        .add_tag(Tag.parse(["ecash", token]))
    )

    # Send event
    try:
        event_id = await client.send_event_builder(event)
        print(f"✅ Event accepted! ID: {event_id.to_hex()}")
        return True
    except Exception as e:
        print(f"❌ Event rejected: {e}")
        return False
    finally:
        await client.disconnect()

async def test_without_token():
    """Test sending an event without an ecash token"""
    print("\nTesting without ecash token...")

    # Create client
    keys = Keys.generate()
    client = Client(keys)

    # Connect to relay
    await client.add_relay(RELAY_URL)
    await client.connect()
    print(f"Connected to relay: {RELAY_URL}")

    # Create event without token
    event = EventBuilder.text_note("Test event without payment")

    # Send event
    try:
        event_id = await client.send_event_builder(event)
        print(f"❌ Event accepted (should have been rejected!): {event_id.to_hex()}")
        return False
    except Exception as e:
        print(f"✅ Event rejected as expected: {e}")
        return True
    finally:
        await client.disconnect()

async def test_with_spent_token():
    """Test sending an event with an already spent token"""
    print("\nTesting with already spent token...")

    # Mint and spend a token
    token = await mint_token(1)

    # First, use the token
    keys1 = Keys.generate()
    client1 = Client(keys1)
    await client1.add_relay(RELAY_URL)
    await client1.connect()

    event1 = (
        EventBuilder.text_note("First use of token")
        .add_tag(Tag.parse(["ecash", token]))
    )

    try:
        await client1.send_event_builder(event1)
        print("First use of token succeeded")
    except Exception as e:
        print(f"First use failed: {e}")
        return False
    finally:
        await client1.disconnect()

    # Try to reuse the same token
    keys2 = Keys.generate()
    client2 = Client(keys2)
    await client2.add_relay(RELAY_URL)
    await client2.connect()

    event2 = (
        EventBuilder.text_note("Reuse of spent token")
        .add_tag(Tag.parse(["ecash", token]))
    )

    try:
        event_id = await client2.send_event_builder(event2)
        print(f"❌ Token reuse accepted (should have been rejected!): {event_id.to_hex()}")
        return False
    except Exception as e:
        print(f"✅ Token reuse rejected as expected: {e}")
        return True
    finally:
        await client2.disconnect()

async def main():
    print("=" * 60)
    print("ECASH RELAY PLUGIN TEST")
    print("=" * 60)

    # Wait for services to be ready
    print("Waiting for services to be ready...")
    await asyncio.sleep(2)

    results = []

    # Run tests
    try:
        # Test 1: With valid token
        results.append(("Valid token", await test_with_token()))

        # Test 2: Without token
        results.append(("No token", await test_without_token()))

        # Test 3: With spent token
        results.append(("Spent token", await test_with_spent_token()))

    except Exception as e:
        print(f"\nTest error: {e}")
        print("Make sure the relay and mint are running!")
        return

    # Print results
    print("\n" + "=" * 60)
    print("TEST RESULTS")
    print("=" * 60)

    for test_name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{test_name:20} {status}")

    all_passed = all(passed for _, passed in results)
    print("\n" + ("🎉 ALL TESTS PASSED!" if all_passed else "⚠️ SOME TESTS FAILED"))

if __name__ == "__main__":
    asyncio.run(main())