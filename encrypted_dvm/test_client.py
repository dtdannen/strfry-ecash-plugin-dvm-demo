#!/usr/bin/env python3
"""
NIP-17 Encrypted DVM Test Client
=================================

Test client for sending encrypted job requests to DVMs using NIP-17 gift wrap.
This is a debugging tool, not part of the production system.

Usage:
    python test_client.py

    or to specify a DVM npub:
    DVM_NPUB=npub1... python test_client.py

The test client will:
1. Generate ephemeral keys for the session
2. Send multiple encrypted test messages to the DVM
3. Listen for and decrypt responses
4. Display the full encryption/decryption process
"""

import asyncio
import os
from pathlib import Path
from typing import Optional
from nostr_sdk import (
    Client,
    Keys,
    EventBuilder,
    Filter,
    Kind,
    Tag,
    Timestamp,
    Event,
    HandleNotification,
    RelayMessage,
    NostrSigner,
    RelayUrl,
    PublicKey,
)

# Import our shared NIP-17 crypto library
from nip17_crypto import encrypt_nip17_message, decrypt_nip17_gift_wrap


class EncryptedDVMTestClient:
    """
    Test client for sending encrypted job requests to DVMs using NIP-17 gift wrap
    """

    def __init__(self, keys: Keys, relay_urls: list, dvm_npub: str):
        self.keys = keys
        self.relay_urls = relay_urls
        self.client = None
        self.dvm_npub = dvm_npub
        self.dvm_pubkey = None

        # Track responses
        self.responses_received = 0
        self.waiting_for_response = {}

        print(f"🔐 Encrypted Test Client")
        print(f"🔑 Client Public Key: {self.keys.public_key().to_bech32()}")

        # Parse DVM public key
        try:
            self.dvm_pubkey = PublicKey.parse(dvm_npub)
            print(f"🎯 Target DVM: {dvm_npub}")
            print(f"✅ All messages will be encrypted for this DVM")
        except Exception as e:
            print(f"❌ Error parsing DVM npub: {e}")
            raise

    async def initialize(self):
        """Initialize the client and connect to relays"""
        signer = NostrSigner.keys(self.keys)
        self.client = Client(signer)

        # Add relays
        for relay_url in self.relay_urls:
            relay = RelayUrl.parse(relay_url)
            await self.client.add_relay(relay)
            print(f"✅ Added relay: {relay_url}")

        # Connect to relays
        await self.client.connect()
        print("✅ Connected to relays")

        # Subscribe to encrypted responses
        await self.subscribe_to_encrypted_responses()

    async def subscribe_to_encrypted_responses(self):
        """
        Subscribe to encrypted gift wrap events (kind 1059) addressed to us.
        """

        print(f"\n🔐 Setting up subscription for encrypted responses...")

        # Subscribe to ALL gift wraps from recent time
        # We'll filter in the handler for our pubkey
        two_days_ago = Timestamp.now().as_secs() - (2 * 24 * 60 * 60)

        encrypted_filter = (
            Filter()
            .kind(Kind(1059))  # Gift wrap events
            .since(Timestamp.from_secs(two_days_ago))
        )

        subscription_result = await self.client.subscribe(encrypted_filter)
        print(f"✅ Subscribed to gift wraps: {subscription_result}")
        print(f"🔍 Will filter for our pubkey: {self.keys.public_key().to_hex()[:16]}...")

    async def send_encrypted_job_request(self, input_text: str):
        """Create and send an encrypted job request to the DVM"""
        print("\n" + "="*60)
        print("🚀 SENDING ENCRYPTED JOB REQUEST")
        print("="*60)

        try:
            # Prepare job request tags and content
            job_request_tags = [
                ["i", input_text, "text/plain"],  # Input data
                ["category", "echo"],  # Service category
            ]

            job_content = f"Encrypted job request: {input_text}"

            print(f"📝 Input: '{input_text}'")

            # Use shared NIP-17 crypto library
            gift_wrap_event = await encrypt_nip17_message(
                sender_keys=self.keys,
                recipient_pubkey=self.dvm_pubkey,
                message_content=job_content,
                message_tags=job_request_tags,
                message_kind=25000,  # DVM job request
                verbose=True  # Show encryption process
            )

            print(f"\n📡 Broadcasting gift wrap to relays...")

            # Send the gift wrap event to relays
            await self.client.send_event(gift_wrap_event)

            print("✅ Successfully sent encrypted job request!")
            print(f"⏳ Waiting for encrypted response...")

            # Track this request
            self.waiting_for_response[gift_wrap_event.id().to_hex()] = {
                'input_text': input_text,
                'sent_at': asyncio.get_event_loop().time()
            }

            return gift_wrap_event

        except Exception as e:
            print(f"\n❌ Error sending encrypted job request: {e}")
            import traceback
            traceback.print_exc()
            return None

    async def handle_encrypted_response(self, gift_wrap_event: Event):
        """Handle an encrypted response from the DVM"""
        print(f"\n🎉 RECEIVED ENCRYPTED RESPONSE!")
        print(f"📦 Gift wrap ID: {gift_wrap_event.id().to_hex()[:16]}...")

        # Decrypt the response
        try:
            # Use shared NIP-17 crypto library with verbose logging
            decrypted_event, real_sender = await decrypt_nip17_gift_wrap(
                recipient_keys=self.keys,
                gift_wrap_event=gift_wrap_event,
                verbose=True  # Show decryption process
            )

            if decrypted_event and real_sender:
                self.responses_received += 1

                print(f"\n📋 DVM Response Summary:")
                print(f"   ✅ Successfully decrypted response")
                print(f"   📄 Content: {decrypted_event.content()}")
                print(f"   👤 From DVM: {real_sender.to_bech32()[:16]}...")
                print(f"   🔐 End-to-end encryption verified!")
                print(f"   📊 Total responses received: {self.responses_received}")

                # Verify this is from expected DVM
                expected_npub = self.dvm_pubkey.to_bech32()
                actual_npub = real_sender.to_bech32()

                if expected_npub == actual_npub:
                    print(f"   ✅ Response verified from expected DVM")
                else:
                    print(f"   ⚠️  Response from unexpected sender!")
            else:
                print(f"❌ Failed to decrypt response")

        except Exception as e:
            print(f"❌ Error handling response: {e}")
            import traceback
            traceback.print_exc()

    async def run_test_session(self, test_messages: list):
        """Run a test session sending multiple encrypted requests"""
        print("\n" + "="*80)
        print("🎭 STARTING NIP-17 ENCRYPTED TEST SESSION")
        print("="*80)

        if not self.client:
            await self.initialize()

        print(f"\n🎯 Testing with {len(test_messages)} encrypted messages...")

        # Create notification handler for responses
        class ResponseHandler(HandleNotification):
            def __init__(self, test_client):
                self.test_client = test_client

            async def handle(self, relay_url: str, subscription_id: str, event: Event):
                if event.kind().as_u16() == 1059:  # Gift wrap
                    # Check if this is for us
                    our_pubkey = self.test_client.keys.public_key().to_hex()

                    for tag in event.tags().to_vec():
                        tag_vec = tag.as_vec()
                        if len(tag_vec) >= 2 and tag_vec[0] == "p" and tag_vec[1] == our_pubkey:
                            print(f"\n🎯 Received gift wrap for us from {relay_url}")
                            await self.test_client.handle_encrypted_response(event)
                            break

            async def handle_msg(self, relay_url: str, msg: RelayMessage):
                pass

        handler = ResponseHandler(self)

        # Start handling notifications
        notification_task = asyncio.create_task(self.client.handle_notifications(handler))

        try:
            # Send test messages with delays
            for i, message in enumerate(test_messages, 1):
                print(f"\n📨 Sending test message {i}/{len(test_messages)}")
                await self.send_encrypted_job_request(message)

                # Wait a bit between messages
                if i < len(test_messages):
                    print(f"⏳ Waiting 3 seconds before next message...")
                    await asyncio.sleep(3)

            print(f"\n✅ All {len(test_messages)} encrypted messages sent!")
            print("⏳ Listening for responses for 30 seconds...")

            # Listen for responses
            await asyncio.sleep(30)

            print(f"\n📊 Test Session Complete!")
            print(f"   📤 Messages sent: {len(test_messages)}")
            print(f"   📥 Responses received: {self.responses_received}")

            if self.responses_received < len(test_messages):
                print(f"   ⚠️  Some responses may still be in transit")
                print("   💡 Check that the DVM is running and processing requests")

        except Exception as e:
            print(f"❌ Error in test session: {e}")
        finally:
            notification_task.cancel()
            try:
                await notification_task
            except asyncio.CancelledError:
                pass


def load_dvm_pubkey():
    """
    Load DVM public key from environment variables or .env file
    """
    # First try environment variables
    dvm_npub = os.getenv("DVM_NPUB")
    if dvm_npub:
        print("🔑 Loaded DVM_NPUB from environment variable")
        return dvm_npub

    # Check for local .env file (if running outside Docker)
    env_file = Path(__file__).parent / ".env"
    if env_file.exists():
        with open(env_file, 'r') as f:
            for line in f:
                if line.strip().startswith("DVM_NPUB="):
                    npub = line.strip().split("=", 1)[1].strip('"\'')
                    print("🔑 Loaded DVM_NPUB from .env file")
                    return npub

    # Check Docker volume location
    docker_env = Path("/data/.env.encrypted")
    if docker_env.exists():
        with open(docker_env, 'r') as f:
            for line in f:
                if line.strip().startswith("DVM_NPUB="):
                    npub = line.strip().split("=", 1)[1].strip('"\'')
                    print("🔑 Loaded DVM_NPUB from Docker .env file")
                    return npub

    print("❌ DVM_NPUB not found in environment or .env files")
    print("💡 You can:")
    print("   1. Set DVM_NPUB environment variable")
    print("   2. Create .env file with DVM_NPUB=npub1...")
    print("   3. Run the encrypted DVM first to generate keys")
    return None


async def main():
    """Run NIP-17 encrypted DVM test session"""
    print("🔐 NIP-17 ENCRYPTED DVM TEST CLIENT")
    print("="*60)
    print("This tool tests encrypted communication with NIP-17 DVMs")
    print()

    # Generate test keys for this session
    client_keys = Keys.generate()
    print(f"🔑 Generated ephemeral test keys")
    print(f"   Client npub: {client_keys.public_key().to_bech32()}")

    # Load DVM public key
    dvm_npub = load_dvm_pubkey()
    if not dvm_npub:
        print("\n❌ Cannot proceed without DVM public key")
        print("💡 Please run the encrypted DVM first to generate keys,")
        print("   then set DVM_NPUB environment variable or create .env file")
        return

    # Setup relay URLs
    relay_urls = [os.getenv("RELAY_URL", "ws://localhost:7788")]
    print(f"\n🌐 Using relay: {relay_urls[0]}")

    # Create test client
    client = EncryptedDVMTestClient(client_keys, relay_urls, dvm_npub)

    # Test messages
    test_messages = [
        "Hello, encrypted DVM!",
        "Can you echo this secret message?",
        "Testing NIP-17 encryption 🔐",
        "Final test message - encryption working great!"
    ]

    try:
        await client.run_test_session(test_messages)
    except KeyboardInterrupt:
        print("\n👋 Test interrupted by user")
        return

    print("\n🎭 Test completed!")
    print("👋 Thanks for testing NIP-17 encrypted DVMs!")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 Goodbye!")