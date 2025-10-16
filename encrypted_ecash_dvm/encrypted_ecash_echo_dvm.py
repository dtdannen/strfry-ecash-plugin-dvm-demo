#!/usr/bin/env python3
"""
NIP-17 Encrypted Echo DVM with Ecash Payment Validation
Processes encrypted DVM requests after validating ecash payment tokens.
"""

import asyncio
import json
import os
import time
from typing import Optional, Dict, Any, List
from pathlib import Path
import logging
from datetime import datetime
from collections import defaultdict

from nostr_sdk import (
    Client, NostrSigner, NostrDatabase, Keys, PublicKey, EventBuilder,
    Filter, HandleNotification, Event, Kind, Tag, Timestamp, RelayOptions,
    EventId, Alphabet, RelayUrl
)

from cashu.wallet.wallet import Wallet
from nip17_crypto import Nip17Crypto

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("encrypted_ecash_dvm")

# Configuration
RELAY_URL = os.getenv("RELAY_URL", "ws://localhost:7777")
MINT_URL = os.getenv("MINT_URL", "http://cdk-mint:8096")
REQUIRED_SATS = int(os.getenv("REQUIRED_SATS", "1"))
DATA_DIR = Path("/data")
ENV_FILE = DATA_DIR / ".env"

# DVM configuration
DVM_SERVICE_KIND = 25000  # Echo service
GIFT_WRAP_KIND = 1059

class EcashDVMHandler(HandleNotification):
    def __init__(self, dvm):
        self.dvm = dvm

    async def handle(self, relay_url: str, subscription_id: str, event: Event):
        """Handle incoming events"""
        asyncio.create_task(self.dvm.handle_event(event, relay_url))

    async def handle_msg(self, relay_url: str, msg: str):
        """Handle relay messages"""
        pass

class EncryptedEcashDVM:
    def __init__(self):
        self.keys = None
        self.client = None
        self.processed_jobs = set()
        self.crypto = None
        self.wallet = None
        self.stats = {
            'total_requests': 0,
            'valid_payments': 0,
            'invalid_payments': 0,
            'processing_errors': 0,
            'validation_times': [],
            'processing_times': [],
            'total_sats_earned': 0,
            'unique_users': set()
        }
        self.user_spending = defaultdict(int)  # Track spending per user

    async def load_or_create_keys(self) -> Keys:
        """Load existing keys or create new ones"""
        if ENV_FILE.exists():
            logger.info("Loading existing DVM keys...")
            with open(ENV_FILE, 'r') as f:
                for line in f:
                    if line.startswith("DVM_PRIVATE_KEY="):
                        private_key = line.strip().split('=')[1]
                        keys = Keys.parse(private_key)
                        logger.info(f"Loaded DVM keys: {keys.public_key().to_bech32()}")
                        return keys

        logger.info("Creating new DVM keys...")
        keys = Keys.generate()
        DATA_DIR.mkdir(parents=True, exist_ok=True)

        with open(ENV_FILE, 'w') as f:
            f.write(f"DVM_PRIVATE_KEY={keys.secret_key().to_hex()}\n")
            f.write(f"DVM_NPUB={keys.public_key().to_bech32()}\n")
            f.write(f"DVM_PUBKEY_HEX={keys.public_key().to_hex()}\n")

        logger.info(f"Created new DVM with npub: {keys.public_key().to_bech32()}")
        return keys

    async def extract_ecash_token(self, content: str, tags: List[List[str]]) -> Optional[str]:
        """Extract ecash token from event content or tags"""
        # Check tags first
        for tag in tags:
            if len(tag) >= 2 and tag[0] == 'ecash':
                logger.info("Found ecash token in tag")
                return tag[1]

        # Check content for cashu tokens
        import re
        cashu_pattern = r'(cashu[AB][A-Za-z0-9+/]+=*)'
        match = re.search(cashu_pattern, content)
        if match:
            logger.info("Found ecash token in content")
            return match.group(1)

        return None

    async def validate_ecash_payment(self, token: str) -> tuple[bool, str, int]:
        """
        Validate and redeem ecash token.
        Returns (is_valid, message, amount_sats)
        """
        start_time = time.time()

        try:
            # Try to receive (spend) the token
            proofs = await self.wallet.receive(token)

            validation_time = (time.time() - start_time) * 1000
            self.stats['validation_times'].append(validation_time)

            if proofs:
                total_amount = sum(p.amount for p in proofs)

                if total_amount >= REQUIRED_SATS:
                    logger.info(f"Valid payment: {total_amount} sats (validation: {validation_time:.2f}ms)")
                    self.stats['total_sats_earned'] += total_amount
                    return True, f"Payment accepted: {total_amount} sats", total_amount
                else:
                    logger.warning(f"Insufficient payment: {total_amount} sats < {REQUIRED_SATS} required")
                    return False, f"Insufficient payment: {total_amount} sats", 0
            else:
                logger.warning("No proofs returned from token validation")
                return False, "Invalid or already spent token", 0

        except Exception as e:
            validation_time = (time.time() - start_time) * 1000
            self.stats['validation_times'].append(validation_time)

            error_msg = str(e)
            if "already spent" in error_msg.lower():
                logger.warning(f"Token already spent: {error_msg}")
                return False, "Token already spent", 0
            else:
                logger.error(f"Error validating token: {error_msg}")
                return False, f"Payment validation error: {error_msg}", 0

    async def process_dvm_request(self, event: Event):
        """Process decrypted DVM request with ecash validation"""
        start_time = time.time()

        try:
            # Extract input from 'i' tags
            input_text = None
            for tag in event.tags():
                if tag.as_vec()[0] == "i":
                    input_text = tag.as_vec()[1] if len(tag.as_vec()) > 1 else None
                    break

            if not input_text:
                logger.warning("No input text found in DVM request")
                await self.send_encrypted_error_response(
                    event,
                    event.author().to_hex(),
                    "No input provided"
                )
                return

            # Extract ecash token
            token = await self.extract_ecash_token(event.content(), event.tags().to_vec())

            if not token:
                self.stats['invalid_payments'] += 1
                logger.warning("No ecash token found in request")
                await self.send_encrypted_error_response(
                    event,
                    event.author().to_hex(),
                    f"Payment required: {REQUIRED_SATS} sats minimum"
                )
                return

            # Validate ecash payment
            is_valid, payment_msg, amount = await self.validate_ecash_payment(token)

            if not is_valid:
                self.stats['invalid_payments'] += 1
                await self.send_encrypted_error_response(
                    event,
                    event.author().to_hex(),
                    payment_msg
                )
                return

            self.stats['valid_payments'] += 1
            self.stats['unique_users'].add(event.author().to_hex())
            self.user_spending[event.author().to_hex()] += amount

            # Process the echo request
            echo_output = f"ECHO: {input_text}"
            logger.info(f"Processing paid request: '{input_text}' -> '{echo_output}'")

            # Send encrypted response
            await self.send_encrypted_response(event, event.author().to_hex(), echo_output)

            processing_time = (time.time() - start_time) * 1000
            self.stats['processing_times'].append(processing_time)
            logger.info(f"Request processed in {processing_time:.2f}ms (payment: {amount} sats)")

        except Exception as e:
            self.stats['processing_errors'] += 1
            logger.error(f"Error processing DVM request: {e}")
            await self.send_encrypted_error_response(
                event,
                event.author().to_hex(),
                "Processing error occurred"
            )

    async def handle_event(self, event: Event, relay_url: str):
        """Handle incoming events"""
        self.stats['total_requests'] += 1

        # Handle gift-wrapped events
        if event.kind().as_u16() == GIFT_WRAP_KIND:
            event_id = event.id().to_hex()

            if event_id in self.processed_jobs:
                logger.debug(f"Skipping already processed job: {event_id}")
                return

            self.processed_jobs.add(event_id)
            logger.info(f"Received gift wrap from {relay_url}")

            try:
                # Decrypt the gift wrap
                decrypted = await self.crypto.decrypt_gift_wrap(event)

                if decrypted:
                    seal_event, inner_event, sender_pubkey = decrypted
                    logger.info(f"Decrypted request from {sender_pubkey}")

                    # Check if it's a DVM request
                    if inner_event.kind().as_u16() == DVM_SERVICE_KIND:
                        # Process with ecash validation
                        await self.process_dvm_request(inner_event)
                else:
                    logger.warning("Failed to decrypt gift wrap")

            except Exception as e:
                logger.error(f"Error handling gift wrap: {e}")

    async def send_encrypted_response(self, request_event: Event, recipient_pubkey_hex: str, output: str):
        """Send encrypted DVM response"""
        try:
            # Create response event
            response_builder = (
                EventBuilder.new(Kind(DVM_SERVICE_KIND), output)
                .add_tag(Tag.parse(["e", request_event.id().to_hex()]))
                .add_tag(Tag.parse(["p", recipient_pubkey_hex]))
                .add_tag(Tag.parse(["status", "success"]))
                .add_tag(Tag.parse(["payment", f"{self.stats['total_sats_earned']} sats total earned"]))
            )

            # Encrypt and send the response
            recipient_pubkey = PublicKey.from_hex(recipient_pubkey_hex)
            gift_wrap = await self.crypto.create_gift_wrap(
                self.keys,
                recipient_pubkey,
                response_builder
            )

            await self.client.send_event(gift_wrap)
            logger.info(f"Sent encrypted response to {recipient_pubkey.to_bech32()}")

        except Exception as e:
            logger.error(f"Error sending encrypted response: {e}")

    async def send_encrypted_error_response(self, request_event: Event, recipient_pubkey_hex: str, error_msg: str):
        """Send encrypted error response"""
        try:
            # Create error response
            response_builder = (
                EventBuilder.new(Kind(DVM_SERVICE_KIND), f"ERROR: {error_msg}")
                .add_tag(Tag.parse(["e", request_event.id().to_hex()]))
                .add_tag(Tag.parse(["p", recipient_pubkey_hex]))
                .add_tag(Tag.parse(["status", "error"]))
                .add_tag(Tag.parse(["error", error_msg]))
            )

            # Encrypt and send the error
            recipient_pubkey = PublicKey.from_hex(recipient_pubkey_hex)
            gift_wrap = await self.crypto.create_gift_wrap(
                self.keys,
                recipient_pubkey,
                response_builder
            )

            await self.client.send_event(gift_wrap)
            logger.info(f"Sent encrypted error response: {error_msg}")

        except Exception as e:
            logger.error(f"Error sending encrypted error response: {e}")

    async def send_heartbeat(self):
        """Send periodic heartbeat to indicate service is alive"""
        heartbeat = (
            EventBuilder.new(
                Kind(11998),
                json.dumps({
                    "status": "online",
                    "type": "encrypted-ecash-echo",
                    "payment_required": True,
                    "price": f"{REQUIRED_SATS} sats",
                    "stats": {
                        "requests": self.stats['total_requests'],
                        "valid_payments": self.stats['valid_payments'],
                        "invalid_payments": self.stats['invalid_payments'],
                        "total_earned": f"{self.stats['total_sats_earned']} sats",
                        "unique_users": len(self.stats['unique_users'])
                    }
                })
            )
            .add_tag(Tag.parse(["d", "encrypted-ecash-echo"]))
            .add_tag(Tag.parse(["k", str(DVM_SERVICE_KIND)]))
        )

        await self.client.send_event_builder(heartbeat)
        logger.debug(f"Heartbeat sent - Earned: {self.stats['total_sats_earned']} sats, "
                    f"Users: {len(self.stats['unique_users'])}")

    async def print_stats(self):
        """Print periodic statistics"""
        while True:
            await asyncio.sleep(60)  # Print stats every minute

            if self.stats['validation_times']:
                avg_validation = sum(self.stats['validation_times']) / len(self.stats['validation_times'])
            else:
                avg_validation = 0

            if self.stats['processing_times']:
                avg_processing = sum(self.stats['processing_times']) / len(self.stats['processing_times'])
            else:
                avg_processing = 0

            logger.info(f"""
            ===== ECASH DVM STATISTICS =====
            Total Requests: {self.stats['total_requests']}
            Valid Payments: {self.stats['valid_payments']}
            Invalid Payments: {self.stats['invalid_payments']}
            Processing Errors: {self.stats['processing_errors']}
            Total Earned: {self.stats['total_sats_earned']} sats
            Unique Users: {len(self.stats['unique_users'])}
            Avg Validation Time: {avg_validation:.2f}ms
            Avg Processing Time: {avg_processing:.2f}ms
            ================================
            """)

    async def run(self):
        """Main DVM loop"""
        try:
            # Load or create keys
            self.keys = await self.load_or_create_keys()
            self.crypto = Nip17Crypto(self.keys)

            # Initialize wallet
            # Cashu 0.17.0 requires a database path
            self.wallet = Wallet(MINT_URL, db="/data/ecash_wallet.db")
            await self.wallet.load_mint()
            logger.info(f"Connected to mint: {MINT_URL}")

            # Initialize Nostr client
            signer = NostrSigner.keys(self.keys)
            self.client = Client(signer)

            # Add relay
            relay_url = RelayUrl.parse(RELAY_URL)
            await self.client.add_relay(relay_url)
            await self.client.connect()
            logger.info(f"Connected to relay: {RELAY_URL}")

            # Subscribe to gift wraps sent to us
            my_pubkey = self.keys.public_key()
            filter_gift_wrap = (
                Filter()
                .kind(Kind(GIFT_WRAP_KIND))
                .pubkey(my_pubkey)
            )

            await self.client.subscribe(filter_gift_wrap)
            logger.info(f"Subscribed to encrypted requests for {my_pubkey.to_bech32()}")

            # Handle events
            handler = EcashDVMHandler(self)
            await self.client.handle_notifications(handler)

            # Start background tasks
            asyncio.create_task(self.print_stats())

            # Send heartbeat every 10 seconds
            while True:
                await self.send_heartbeat()
                await asyncio.sleep(10)

        except Exception as e:
            logger.error(f"DVM error: {e}")
            raise

async def main():
    logger.info(f"""
    ======================================
    Starting Encrypted Ecash Echo DVM
    Relay: {RELAY_URL}
    Mint: {MINT_URL}
    Price: {REQUIRED_SATS} sats per request
    ======================================
    """)

    dvm = EncryptedEcashDVM()
    await dvm.run()

if __name__ == "__main__":
    asyncio.run(main())