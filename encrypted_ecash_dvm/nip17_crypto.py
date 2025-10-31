#!/usr/bin/env python3
"""
NIP-17 Encryption/Decryption Library
====================================

Shared library for NIP-17 gift wrap encryption and decryption.
Used by both test clients and DVMs to ensure consistent implementation.

This implements the NIP-17 specification:
https://github.com/nostr-protocol/nips/blob/master/17.md
"""

import json
import random
from datetime import datetime
from typing import Optional, Tuple
from nostr_sdk import (
    Keys,
    EventBuilder,
    Kind,
    Tag,
    Timestamp,
    Event,
    EventId,
    NostrSigner,
    nip44_encrypt,
    nip44_decrypt,
    Nip44Version,
    PublicKey,
    UnsignedEvent,
)


async def encrypt_nip17_message(
    sender_keys: Keys,
    recipient_pubkey: PublicKey,
    message_content: str,
    message_tags: list = None,
    message_kind: int = 25000,
    verbose: bool = False,
    gift_wrap_tags: list = None
) -> Event:
    """
    Encrypt a message using NIP-17 gift wrap protocol.

    This implements the full NIP-17 encryption pipeline:
    1. Create the message event (unsigned)
    2. Encrypt the message with sender's private key to recipient's public key
    3. Create the seal event (kind 13) with encrypted message in content
    4. Encrypt the seal with a random private key to recipient's public key
    5. Gift wrap the encrypted seal with the SAME random private key

    Args:
        sender_keys: The sender's Keys object
        recipient_pubkey: The recipient's public key
        message_content: The message content to encrypt
        message_tags: Optional tags for the message (default: empty list)
        message_kind: The kind of message event (default: 25000 for DVM jobs)
        verbose: Enable verbose logging

    Returns:
        The gift wrap event ready to be sent
    """

    if verbose:
        print("\n" + "="*80)
        print("🔐 NIP-17 ENCRYPTION PROCESS")
        print("="*80)

    if message_tags is None:
        message_tags = []

    try:
        # Step 1: Create the message event (unsigned)
        if verbose:
            print(f"\n📋 Step 1: Creating Unsigned Message Event (kind {message_kind})")
            print(f"   📝 Content: '{message_content}'")
            print(f"   🏷️  Tags: {len(message_tags)} tags")

        message_event_builder = EventBuilder(kind=Kind(message_kind), content=message_content)
        message_event_builder = message_event_builder.tags([Tag.parse(tag) if isinstance(tag, list) else tag for tag in message_tags])
        message_event = message_event_builder.build(sender_keys.public_key())

        if verbose:
            print(f"   ✅ Created unsigned message event")

        # Step 2: Encrypt the message with sender's private key to recipient's public key
        if verbose:
            print(f"\n📋 Step 2: Encrypting Message with Sender's Private Key")

        message_json = message_event.as_json()
        encrypted_message = nip44_encrypt(
            sender_keys.secret_key(),
            recipient_pubkey,
            message_json,
            Nip44Version.V2
        )

        if verbose:
            print(f"   ✅ Encrypted message (length: {len(encrypted_message)} chars)")

        # Step 3: Create the seal event (kind 13) with encrypted message in content
        if verbose:
            print(f"\n📋 Step 3: Creating Seal Event (kind 13)")

        # Create random timestamp up to 2 days in the past for anonymity
        random_seconds = random.randint(0, 2 * 24 * 60 * 60)
        current_time = Timestamp.now().as_secs()
        random_timestamp = Timestamp.from_secs(current_time - random_seconds)

        seal_event_builder = EventBuilder(kind=Kind(13), content=encrypted_message)
        seal_event_builder = seal_event_builder.custom_created_at(random_timestamp)
        signer = NostrSigner.keys(sender_keys)
        seal_event = await seal_event_builder.sign(signer)

        if verbose:
            print(f"   ✅ Created and signed seal event")
            print(f"   📅 Seal timestamp: {datetime.fromtimestamp(random_timestamp.as_secs())}")

        # Step 4 & 5: Encrypt seal and create gift wrap with SAME random key (per NIP-17)
        if verbose:
            print(f"\n📋 Step 4: Encrypting Seal and Creating Gift Wrap")
            print("   ⚠️  Using SAME random key for encryption and signing (per NIP-17)")

        # Generate random keys ONCE for both operations
        random_keys = Keys.generate()
        random_private_key = random_keys.secret_key()

        # Encrypt the seal event
        seal_json = seal_event.as_json()
        encrypted_seal = nip44_encrypt(
            random_private_key,
            recipient_pubkey,
            seal_json,
            Nip44Version.V2
        )

        if verbose:
            print(f"   ✅ Encrypted seal event (length: {len(encrypted_seal)} chars)")

        # Create gift wrap with the SAME random keys
        random_seconds = random.randint(0, 2 * 24 * 60 * 60)
        random_timestamp = Timestamp.from_secs(current_time - random_seconds)

        gift_wrap_builder = EventBuilder(kind=Kind(1059), content=encrypted_seal)
        gift_wrap_builder = gift_wrap_builder.custom_created_at(random_timestamp)

        # Build tag list: always include 'p' tag, optionally add custom tags (like ecash)
        tags_to_add = [Tag.parse(["p", recipient_pubkey.to_hex()])]
        if gift_wrap_tags:
            tags_to_add.extend([Tag.parse(tag) if isinstance(tag, list) else tag for tag in gift_wrap_tags])

        gift_wrap_builder = gift_wrap_builder.tags(tags_to_add)

        gift_wrap_signer = NostrSigner.keys(random_keys)  # Same keys as encryption
        gift_wrap_event = await gift_wrap_builder.sign(gift_wrap_signer)

        if verbose:
            print(f"   ✅ Created and signed gift wrap event")
            print(f"   📅 Gift wrap timestamp: {datetime.fromtimestamp(random_timestamp.as_secs())}")
            print(f"\n✅ NIP-17 ENCRYPTION COMPLETE")
            print(f"   🎯 Gift wrap ID: {gift_wrap_event.id().to_hex()[:16]}...")

        return gift_wrap_event

    except Exception as e:
        if verbose:
            print(f"\n❌ Encryption failed: {e}")
        raise


async def decrypt_nip17_gift_wrap(
    recipient_keys: Keys,
    gift_wrap_event: Event,
    verbose: bool = False
) -> Tuple[Optional[Event], Optional[PublicKey]]:
    """
    Decrypt a NIP-17 gift wrap event.

    This reverses the encryption process:
    1. Receive gift wrap (kind 1059)
    2. Decrypt gift wrap content → get seal event JSON
    3. Parse seal event (kind 13) from JSON
    4. Decrypt seal content → get original message JSON
    5. Parse message event from JSON

    Args:
        recipient_keys: The recipient's Keys object (for decryption)
        gift_wrap_event: The gift wrap event to decrypt
        verbose: Enable verbose logging

    Returns:
        Tuple of (decrypted_message_event, real_sender_pubkey) or (None, None) if failed
    """

    if verbose:
        print("\n" + "="*80)
        print("🔐 NIP-17 DECRYPTION PROCESS")
        print("="*80)

    try:
        # Step 1: Analyze the received gift wrap (kind 1059)
        if verbose:
            print(f"\n📋 Step 1: Analyzing Received Gift Wrap (kind 1059)")
            print(f"   📦 Gift wrap ID: {gift_wrap_event.id().to_hex()[:16]}...")
            print(f"   📅 Created at: {datetime.fromtimestamp(gift_wrap_event.created_at().as_secs())}")
            print(f"   🎭 Apparent sender: {gift_wrap_event.author().to_bech32()[:16]}...")
            print("   ⚠️  Note: This sender is RANDOM for anonymity!")

        # Step 2: Decrypt the gift wrap content to get seal event JSON
        if verbose:
            print(f"\n📋 Step 2: Decrypting Gift Wrap → Seal Event JSON")

        decrypted_seal_json = nip44_decrypt(
            recipient_keys.secret_key(),
            gift_wrap_event.author(),
            gift_wrap_event.content(),
        )

        if verbose:
            print(f"   ✅ Successfully decrypted seal event JSON")

        # Step 3: Parse the seal event (kind 13) from JSON
        if verbose:
            print(f"\n📋 Step 3: Parsing Seal Event (kind 13)")

        seal_event = Event.from_json(decrypted_seal_json)

        if verbose:
            print(f"   ✅ Parsed seal event")
            print(f"   🔑 Real sender: {seal_event.author().to_bech32()[:16]}...")

        # Step 4: Decrypt the seal content to get original message JSON
        if verbose:
            print(f"\n📋 Step 4: Decrypting Seal → Original Message JSON")

        decrypted_message_json = nip44_decrypt(
            recipient_keys.secret_key(),
            seal_event.author(),
            seal_event.content(),
        )

        if verbose:
            print(f"   ✅ Successfully decrypted message JSON")

        # Step 5: Parse the message event from JSON
        if verbose:
            print(f"\n📋 Step 5: Parsing Original Message Event")

        # Try to parse as Event first, fall back to UnsignedEvent if that fails
        try:
            message_event = Event.from_json(decrypted_message_json)
        except:
            # If it's an unsigned event, we need to handle it differently
            message_data = json.loads(decrypted_message_json)
            if verbose:
                print(f"   📝 Message content: {message_data.get('content', '')}")

            # Create a simple event object with the data we need
            class SimpleEvent:
                def __init__(self, data):
                    self.data = data
                    # Calculate the event ID for this unsigned event
                    self._event_id = self._calculate_event_id()

                def _calculate_event_id(self):
                    """Calculate the event ID according to NIP-01"""
                    import hashlib
                    # Create the canonical event format for hashing [0, pubkey, created_at, kind, tags, content]
                    canonical = [
                        0,  # Reserved for future use
                        self.data.get('pubkey', ''),
                        self.data.get('created_at', 0),
                        self.data.get('kind', 0),
                        self.data.get('tags', []),
                        self.data.get('content', '')
                    ]
                    # Serialize to JSON without spaces
                    canonical_json = json.dumps(canonical, separators=(',', ':'), ensure_ascii=False)
                    # Calculate SHA256 hash
                    event_id_hex = hashlib.sha256(canonical_json.encode('utf-8')).hexdigest()
                    # Create EventId from hex string
                    return EventId.parse(event_id_hex)

                def content(self):
                    return self.data.get('content', '')

                def tags(self):
                    class SimpleTags:
                        def __init__(self, tags_data):
                            self.tags_data = tags_data

                        def to_vec(self):
                            return [SimpleTag(tag) for tag in self.tags_data]

                        def __iter__(self):
                            """Make SimpleTags iterable"""
                            return iter([SimpleTag(tag) for tag in self.tags_data])

                    class SimpleTag:
                        def __init__(self, tag_data):
                            self.tag_data = tag_data

                        def as_vec(self):
                            return self.tag_data

                    return SimpleTags(self.data.get('tags', []))

                def id(self):
                    return self._event_id

                def kind(self):
                    """Return the kind as a Kind object"""
                    from nostr_sdk import Kind
                    return Kind(self.data.get('kind', 0))

                def author(self):
                    """Return the author as a PublicKey object"""
                    from nostr_sdk import PublicKey
                    return PublicKey.parse(self.data.get('pubkey', ''))

            message_event = SimpleEvent(message_data)

        real_sender = seal_event.author()

        if verbose:
            print(f"   ✅ Successfully parsed message event")
            print(f"\n✅ NIP-17 DECRYPTION COMPLETE")
            print(f"   👤 Real sender: {real_sender.to_bech32()}")
            print(f"   📄 Message: {message_event.content()}")

        return message_event, real_sender

    except Exception as e:
        if verbose:
            print(f"\n❌ Decryption failed: {e}")
            import traceback
            traceback.print_exc()
        return None, None


class Nip17Crypto:
    """Wrapper class for NIP-17 encryption/decryption functions"""

    def __init__(self, keys: Keys):
        self.keys = keys

    async def create_gift_wrap(self, sender_keys: Keys, recipient_pubkey: PublicKey, message_builder: EventBuilder) -> Event:
        """Create an encrypted gift wrap event"""
        # Build the unsigned message event
        message_event = message_builder.build(sender_keys.public_key())

        # Extract message details
        message_content = message_event.content()
        message_tags = [[t.as_vec()[i] for i in range(len(t.as_vec()))] for t in message_event.tags()]
        message_kind = message_event.kind().as_u16()

        # Encrypt and wrap the message
        return await encrypt_nip17_message(
            sender_keys,
            recipient_pubkey,
            message_content,
            message_tags,
            message_kind,
            verbose=False
        )

    async def decrypt_gift_wrap(self, gift_wrap_event: Event) -> Optional[Tuple[Event, Event, PublicKey]]:
        """Decrypt a gift wrap event"""
        message_event, real_sender = await decrypt_nip17_gift_wrap(
            self.keys,
            gift_wrap_event,
            verbose=False
        )

        if message_event and real_sender:
            # Return (seal_event, message_event, sender_pubkey)
            # For compatibility, we return the message_event twice since we don't need seal separately
            return (gift_wrap_event, message_event, real_sender)

        return None