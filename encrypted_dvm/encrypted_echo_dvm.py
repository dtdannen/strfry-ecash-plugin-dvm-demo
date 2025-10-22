#!/usr/bin/env python3
"""
NIP-17 Encrypted Echo DVM
=========================

Echo DVM that only accepts and responds with NIP-17 gift wrap encrypted messages.
Returns whatever input it receives, using end-to-end encryption.

This DVM demonstrates:
- Receiving NIP-17 gift wrap encrypted requests (kind 1059)
- Decrypting them to get the original job request
- Processing echo jobs (same as regular DVM)
- Encrypting responses using NIP-17 gift wrap
- Complete privacy with random timestamps and ephemeral keys
"""

import asyncio
import os
from datetime import datetime
from typing import Optional
from pathlib import Path
import traceback
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


class NIP17EncryptedEchoDVM:
    """
    NIP-17 Encrypted Echo DVM.

    This DVM:
    - Only accepts encrypted requests via NIP-17 gift wrap
    - Decrypts requests to process them
    - Encrypts all responses using NIP-17
    - Provides complete end-to-end encryption
    """

    def __init__(
        self, keys: Keys, relay_urls: list[str], dvm_name: str = "NIP-17 Encrypted Echo DVM"
    ):
        self.keys = keys
        self.relay_urls = relay_urls
        self.dvm_name = dvm_name
        self.client = None

        # Track processed jobs to avoid duplicates
        self.processed_jobs = set()

        # Track statistics
        self.stats = {
            'requests_received': 0,
            'requests_processed': 0,
            'requests_failed': 0,
            'unique_users': set()
        }

        print(f"🔐 Initializing {dvm_name}")
        print(f"🔑 DVM Public Key: {self.keys.public_key().to_bech32()}")
        print(f"🔑 DVM Pubkey Hex: {self.keys.public_key().to_hex()}")
        print("🔐 This DVM ONLY accepts encrypted requests via NIP-17 gift wrap")

    async def initialize(self):
        """Initialize the Nostr client and connect to relays"""
        print("\n🌐 Connecting to Nostr Network...")

        signer = NostrSigner.keys(self.keys)
        self.client = Client(signer)

        # Add relays
        for relay_url in self.relay_urls:
            relay = RelayUrl.parse(relay_url)
            await self.client.add_relay(relay)
            print(f"   ✅ Added relay: {relay_url}")

        # Connect to relays
        await self.client.connect()
        print("✅ Connected to all relays")

        # Subscribe to encrypted job requests
        await self.subscribe_to_encrypted_requests()

    async def subscribe_to_encrypted_requests(self):
        """Subscribe to encrypted gift wrap events (kind 1059)"""

        print("\n🎯 Setting Up Encrypted Subscriptions")
        print("📝 Subscribing to NIP-17 gift wrap events (kind 1059)")

        # Filter for ALL gift wraps (kind 1059) - we'll filter by p-tag in the handler
        # Subscribe to events from 2 days ago to catch gift wraps with random timestamps
        two_days_ago = Timestamp.now().as_secs() - (2 * 24 * 60 * 60)
        encrypted_filter = (
            Filter().kind(Kind(1059)).since(Timestamp.from_secs(two_days_ago))
        )

        print(f"🕐 Subscribing to gift wraps from 2 days ago onwards")
        print(f"🔑 Will only process gift wraps with our p-tag: {self.keys.public_key().to_hex()[:16]}...")

        subscription = await self.client.subscribe(encrypted_filter)
        print(f"✅ Subscribed to gift wraps: {subscription}")
        print("⏳ Waiting for encrypted job requests...")

    async def decrypt_gift_wrap(self, gift_wrap_event: Event) -> tuple[Optional[Event], Optional[PublicKey]]:
        """
        Decrypt a NIP-17 gift wrap event.

        Returns tuple of (job_event, real_sender_pubkey) or (None, None) if decryption fails.
        """

        # Use shared NIP-17 crypto library (verbose=False for production)
        job_event, real_sender = await decrypt_nip17_gift_wrap(
            recipient_keys=self.keys,
            gift_wrap_event=gift_wrap_event,
            verbose=False  # Set to True for debugging
        )

        if job_event and real_sender:
            # Track statistics
            sender_npub = real_sender.to_bech32()
            self.stats['unique_users'].add(sender_npub)
            print(f"📊 Unique users served: {len(self.stats['unique_users'])}")

        return job_event, real_sender

    def extract_input_from_event(self, event) -> str:
        """Extract input data from job request event (works with Event or SimpleEvent)"""
        # Look for 'i' tag (input tag)
        for tag in event.tags().to_vec():
            tag_vec = tag.as_vec()
            if len(tag_vec) >= 2 and tag_vec[0] == "i":
                return tag_vec[1]

        # Fallback to event content if no 'i' tag
        return event.content()

    async def process_job_request(self, event) -> Optional[str]:
        """Process echo job - just return the input"""

        input_data = self.extract_input_from_event(event)

        if not input_data:
            print("❌ No input data found in job request")
            return None

        print(f"📝 Processing echo request: '{input_data}'")

        # Create echo response
        echo_response = f"Echo: {input_data}"

        print(f"✅ Echo response prepared: '{echo_response}'")

        return echo_response

    async def send_encrypted_result(
        self,
        original_event,
        result: str,
        recipient_pubkey: PublicKey,
        success: bool = True,
    ) -> Optional[Event]:
        """
        Send an encrypted job result using NIP-17 gift wrap.
        """

        print(f"\n🔐 Encrypting Response...")

        try:
            # Prepare result tags
            result_tags = []

            # Add reference to original request if it has an ID
            if hasattr(original_event, 'id'):
                event_id = original_event.id()
                if hasattr(event_id, 'to_hex'):
                    result_tags.append(["e", event_id.to_hex()])

            # Tag the requester
            result_tags.append(["p", recipient_pubkey.to_hex()])

            # Add status tag
            if success:
                result_tags.append(["status", "success"])
                print("   ✅ Status: success")
            else:
                result_tags.append(["status", "error"])
                print("   ❌ Status: error")

            # Use shared NIP-17 crypto library
            gift_wrap_event = await encrypt_nip17_message(
                sender_keys=self.keys,
                recipient_pubkey=recipient_pubkey,
                message_content=result,
                message_tags=result_tags,
                message_kind=25000,  # DVM result
                verbose=False  # Set to True for debugging
            )

            # Send the gift wrap event
            await self.client.send_event(gift_wrap_event)

            status_msg = "SUCCESS" if success else "ERROR"
            print(f"✅ Sent encrypted {status_msg} response!")
            print(f"   📦 Gift wrap ID: {gift_wrap_event.id().to_hex()[:16]}...")
            print(f"   🎯 Delivered to: {recipient_pubkey.to_bech32()[:16]}...")

            return gift_wrap_event

        except Exception as e:
            print(f"❌ Failed to send encrypted result: {e}")
            print(f"🔍 Debug: {traceback.format_exc()}")
            return None

    async def handle_encrypted_request(self, gift_wrap_event: Event):
        """
        Handle an encrypted job request.

        This orchestrates the complete flow:
        1. Decrypt the gift wrap
        2. Process the echo job
        3. Send encrypted response
        """

        print(f"\n🎭 NEW ENCRYPTED REQUEST RECEIVED")
        print(f"📦 Gift wrap event ID: {gift_wrap_event.id().to_hex()[:16]}...")

        self.stats['requests_received'] += 1

        # Step 1: Decrypt the gift wrap
        job_event, requester_pubkey = await self.decrypt_gift_wrap(gift_wrap_event)
        if not job_event or not requester_pubkey:
            print("❌ Failed to decrypt gift wrap - skipping request")
            self.stats['requests_failed'] += 1
            return

        # Get job ID (handle both Event and SimpleEvent)
        if hasattr(job_event, 'id'):
            job_id_obj = job_event.id()
            if hasattr(job_id_obj, 'to_hex'):
                job_id = job_id_obj.to_hex()
            else:
                job_id = "unsigned"
        else:
            job_id = "unsigned"

        # Skip if already processed
        if job_id != "unsigned" and job_id in self.processed_jobs:
            print(f"⏭️  Already processed job {job_id[:8]} - skipping")
            return

        if job_id != "unsigned":
            self.processed_jobs.add(job_id)

        print(f"🆔 Job ID: {job_id[:16] if job_id != 'unsigned' else 'unsigned'}...")
        print(f"👤 Real requester: {requester_pubkey.to_bech32()[:16]}...")

        try:
            # Step 2: Process the job
            result = await self.process_job_request(job_event)

            if result is not None:
                # Step 3: Send encrypted successful result
                await self.send_encrypted_result(
                    job_event, result, requester_pubkey, success=True
                )

                self.stats['requests_processed'] += 1
                print(f"✅ Request completed successfully")

            else:
                # Send encrypted error result
                await self.send_encrypted_result(
                    job_event, "Processing failed", requester_pubkey, success=False
                )
                self.stats['requests_failed'] += 1
                print("❌ Job processing failed - sent error response")

        except Exception as e:
            print(f"❌ Error processing job: {e}")
            print(f"🔍 Debug: {traceback.format_exc()}")
            self.stats['requests_failed'] += 1

            # Try to send encrypted error result
            try:
                await self.send_encrypted_result(
                    job_event, f"Error: {str(e)}", requester_pubkey, success=False
                )
            except:
                print("❌ Failed to send error response")

        # Show statistics
        print(f"\n📊 Statistics:")
        print(f"   🔢 Total requests: {self.stats['requests_received']}")
        print(f"   ✅ Processed: {self.stats['requests_processed']}")
        print(f"   ❌ Failed: {self.stats['requests_failed']}")
        print(f"   👥 Unique users: {len(self.stats['unique_users'])}")

    async def send_heartbeat(self):
        """Send periodic heartbeat to indicate DVM is online"""
        heartbeat_count = 0

        while True:
            try:
                heartbeat_count += 1

                # Create heartbeat event (kind 11998) - remains unencrypted for discovery
                event_builder = EventBuilder(kind=Kind(11998), content="online")
                event_builder = event_builder.tags([
                    Tag.parse(["encrypted", "nip17"]),
                    Tag.parse(["category", "echo"])
                ])

                await self.client.send_event_builder(event_builder)

                current_time = datetime.now()
                print(f"\n💓 Heartbeat #{heartbeat_count} at {current_time.strftime('%H:%M:%S')}")
                print(f"   🔐 Advertising: NIP-17 encrypted DVM online")
                print(f"   📊 Stats: {self.stats['requests_processed']} processed, {len(self.stats['unique_users'])} users")

            except Exception as e:
                print(f"❌ Error sending heartbeat: {e}")

            # Wait 30 seconds before next heartbeat
            await asyncio.sleep(30)

    async def run(self):
        """Main run loop"""
        if not self.client:
            await self.initialize()

        print(f"\n🚀 {self.dvm_name} IS NOW RUNNING")
        print("🔐 Listening for NIP-17 encrypted job requests")
        print("🎭 Privacy: Using random timestamps and ephemeral keys")
        print("⌨️  Press Ctrl+C to stop\n")

        # Create notification handler
        class NotificationHandler(HandleNotification):
            def __init__(self, dvm_instance):
                self.dvm_instance = dvm_instance

            async def handle(self, relay_url: str, subscription_id: str, event: Event):
                # Only process gift wrap events (kind 1059) that are for us
                if event.kind().as_u16() == 1059:
                    # Check if this gift wrap is for us (has our pubkey in p-tag)
                    our_pubkey = self.dvm_instance.keys.public_key().to_hex()

                    for tag in event.tags().to_vec():
                        tag_vec = tag.as_vec()
                        if len(tag_vec) >= 2 and tag_vec[0] == "p" and tag_vec[1] == our_pubkey:
                            # This gift wrap is for us!
                            print(f"\n🎯 Received gift wrap from {relay_url}")
                            await self.dvm_instance.handle_encrypted_request(event)
                            break

            async def handle_msg(self, relay_url: str, msg: RelayMessage):
                # Handle relay messages if needed
                pass

        handler = NotificationHandler(self)

        # Start heartbeat task
        heartbeat_task = asyncio.create_task(self.send_heartbeat())

        try:
            # Start handling notifications
            await self.client.handle_notifications(handler)
        finally:
            # Cancel heartbeat task when shutting down
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass


def load_or_create_keys():
    """Load DVM keys from environment variable, .env file, or create new ones"""

    # First, check for environment variable (highest priority)
    dvm_secret_key = os.getenv("DVM_SECRET_KEY")
    if dvm_secret_key:
        try:
            keys = Keys.parse(dvm_secret_key)
            print(f"🔑 Loaded encrypted DVM keys from environment variable")
            return keys
        except Exception as e:
            print(f"❌ Error parsing DVM_SECRET_KEY from environment: {e}")

    # Use /data directory in Docker, fall back to local directory
    if os.path.exists("/data"):
        env_file = Path("/data/.env.encrypted")
    else:
        env_file = Path(__file__).parent / ".env"

    # Try to load existing keys from .env file
    if env_file.exists():
        with open(env_file, "r") as f:
            for line in f:
                if line.strip().startswith("DVM_SECRET_KEY="):
                    nsec = line.strip().split("=", 1)[1].strip("\"'")
                    try:
                        keys = Keys.parse(nsec)
                        print(f"🔑 Loaded existing encrypted DVM keys from {env_file}")
                        return keys
                    except Exception as e:
                        print(f"❌ Error parsing keys from .env: {e}")
                        break

    # Generate new keys if none found or parsing failed
    keys = Keys.generate()
    nsec = keys.secret_key().to_bech32()
    npub = keys.public_key().to_bech32()
    pubkey_hex = keys.public_key().to_hex()

    # Ensure directory exists
    env_file.parent.mkdir(parents=True, exist_ok=True)

    # Save to .env file
    env_content = f"""# NIP-17 Encrypted DVM Keys - Auto-generated
# These keys are used for the NIP-17 Encrypted Echo DVM
DVM_SECRET_KEY={nsec}
DVM_NPUB={npub}
DVM_PUBKEY_HEX={pubkey_hex}

# This DVM only accepts encrypted requests using NIP-17 gift wrap
# Clients must encrypt their requests for this specific DVM pubkey
"""

    with open(env_file, "w") as f:
        f.write(env_content)

    print(f"🔑 Generated new encrypted DVM keys and saved to {env_file}")
    print(f"📋 ENCRYPTED DVM NPUB: {npub}")
    print(f"📋 ENCRYPTED DVM PUBKEY HEX: {pubkey_hex}")
    print(f"⚠️  Share this NPUB with clients so they can send encrypted requests")

    return keys


async def main():
    """Main function to run the NIP-17 Encrypted Echo DVM"""

    print("="*80)
    print("🎭 NIP-17 ENCRYPTED ECHO DVM")
    print("="*80)
    print()
    print("This DVM demonstrates NIP-17 gift wrap encryption for complete")
    print("end-to-end encryption between clients and DVMs.")
    print()
    print("🔐 Features:")
    print("   • NIP-17 gift wrap encryption/decryption")
    print("   • Complete privacy with random timestamps")
    print("   • Ephemeral keys for anonymity")
    print("   • Echo service (returns input as demonstration)")
    print()

    # Load or create DVM keys
    keys = load_or_create_keys()

    # Get relay URL from environment or use default
    relay_url = os.getenv("RELAY_URL", "ws://strfry:7777")
    relay_urls = [relay_url]

    print(f"🌐 Using relay: {relay_url}")

    # Create and run the NIP-17 Encrypted Echo DVM
    dvm = NIP17EncryptedEchoDVM(keys, relay_urls)

    try:
        await dvm.run()
    except KeyboardInterrupt:
        print("\n🎭 Shutting down NIP-17 Encrypted Echo DVM...")
        print("👋 Goodbye!")


if __name__ == "__main__":
    asyncio.run(main())