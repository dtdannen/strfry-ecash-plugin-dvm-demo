#!/usr/bin/env python3
"""
Strfry write policy plugin for validating ecash tokens.
Validates ecash tokens with CDK mint before accepting events.
"""

import sys
import json
import asyncio
import time
import logging
from typing import Dict, Any, Optional
import re
import httpx
from cashu.core.base import TokenV4

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.FileHandler('/tmp/ecash_validator.log')]
)
logger = logging.getLogger('ecash_validator')

# Configuration
MINT_URL = "http://cdk-mint:8096"
REQUIRED_SATS = 1  # Minimum token value required

class EcashValidator:
    """Validates ecash tokens with CDK mint."""

    def __init__(self):
        self.stats = {
            'total_events': 0,
            'accepted': 0,
            'rejected': 0,
            'validation_times': []
        }
        # Note: We no longer track spent proofs locally - the /v1/burn endpoint
        # handles marking proofs as spent in the mint's database

    def extract_token_from_event(self, event: Dict[str, Any]) -> Optional[str]:
        """
        Extract ecash token from event.
        Looks for token in:
        1. Event tags with 'ecash' key
        2. Event content with cashuA or cashuB prefix
        """
        # First check tags for ecash token
        if 'tags' in event:
            for tag in event['tags']:
                if len(tag) >= 2 and tag[0] == 'ecash':
                    logger.info(f"Found ecash token in tag")
                    return tag[1]

        # Then check content for token
        if 'content' in event:
            content = event['content']
            # Look for cashuA or cashuB tokens
            cashu_pattern = r'(cashu[AB][A-Za-z0-9+/]+=*)'
            match = re.search(cashu_pattern, content)
            if match:
                logger.info(f"Found ecash token in content")
                return match.group(1)

        return None

    async def validate_token_with_mint(self, token: str) -> tuple[bool, str, float]:
        """
        Validate and burn token with CDK mint using /v1/swap endpoint with empty outputs.
        This properly validates the proofs cryptographically and marks them as spent.
        Returns (is_valid, message, validation_time_ms)
        """
        start_time = time.time()

        try:
            # Deserialize the token string into TokenV4 object
            token_obj = TokenV4.deserialize(token)

            # Extract proofs from the token
            if not token_obj.proofs or len(token_obj.proofs) == 0:
                logger.warning("Token has no proofs")
                return False, "Token has no proofs", (time.time() - start_time) * 1000

            proofs_to_validate = token_obj.proofs
            total_amount = sum(p.amount for p in proofs_to_validate)

            # Check if amount is sufficient
            if total_amount < REQUIRED_SATS:
                logger.warning(f"Token value too low: {total_amount} sats < {REQUIRED_SATS} required")
                return False, f"Token value too low: {total_amount} sats", (time.time() - start_time) * 1000

            # Use swap endpoint to validate and burn the proofs
            # We'll swap to a single output that we immediately discard (effectively burning)
            async with httpx.AsyncClient() as client:
                # Convert proofs to JSON format expected by swap endpoint
                proofs_json = [
                    {
                        "amount": p.amount,
                        "C": p.C,
                        "secret": p.secret,
                        "id": p.id
                    }
                    for p in proofs_to_validate
                ]

                # Get the mint's keyset to create a blinded message
                keys_response = await client.get(f"{MINT_URL}/v1/keys", timeout=5.0)
                if keys_response.status_code != 200:
                    logger.error("Could not fetch mint keys")
                    return False, "Mint unavailable", (time.time() - start_time) * 1000

                keyset_data = keys_response.json()
                keyset_id = keyset_data.get("keysets", [{}])[0].get("id") if "keysets" in keyset_data else None

                if not keyset_id:
                    logger.error("Could not get keyset ID from mint")
                    return False, "Mint configuration error", (time.time() - start_time) * 1000

                # Create properly formatted blinded messages using the cashu library
                from cashu.core.crypto.secp import PrivateKey

                # Create a blinded message for the full amount using proper cryptographic methods
                # Generate a random blinding factor and derive the blinded point
                blinding_factor = PrivateKey()

                # The B_ field should be the full compressed public key (33 bytes with prefix)
                # This is the format expected by the CDK mint for blinded messages
                blinded_point = blinding_factor.pubkey
                B_ = blinded_point.serialize().hex()  # Full compressed public key (33 bytes = 66 hex chars)

                outputs_json = [{
                    "amount": total_amount,
                    "B_": B_,  # Blinded message (compressed public key as 66-char hex string)
                    "id": keyset_id
                }]

                # Call swap - this validates the proofs and marks them as spent
                swap_response = await client.post(
                    f"{MINT_URL}/v1/swap",
                    json={
                        "inputs": proofs_json,
                        "outputs": outputs_json
                    },
                    timeout=10.0
                )

                validation_time = (time.time() - start_time) * 1000

                if swap_response.status_code == 200:
                    # Swap successful - tokens are now burned (marked as spent)
                    logger.info(f"Token burned successfully via swap: {total_amount} sats in {validation_time:.2f}ms")
                    return True, f"Token valid: {total_amount} sats", validation_time
                else:
                    error_detail = swap_response.text
                    logger.warning(f"Token swap/burn failed: {swap_response.status_code} - {error_detail}")

                    # Parse error message for better feedback
                    if "already spent" in error_detail.lower() or "pending" in error_detail.lower():
                        return False, "Token already spent", validation_time
                    else:
                        return False, f"Token invalid: {error_detail}", validation_time

        except Exception as e:
            validation_time = (time.time() - start_time) * 1000
            error_msg = str(e)

            # Check for specific error types
            if "already spent" in error_msg.lower():
                logger.warning(f"Token already spent: {error_msg}")
                return False, "Token already spent", validation_time
            elif "invalid" in error_msg.lower():
                logger.warning(f"Invalid token: {error_msg}")
                return False, "Invalid token", validation_time
            else:
                logger.error(f"Error validating token: {error_msg}")
                return False, f"Validation error: {error_msg}", validation_time

    async def process_event(self, input_msg: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process incoming event and validate ecash token if present.
        """
        self.stats['total_events'] += 1

        # Extract event from input message
        event = input_msg.get('event', {})
        event_id = event.get('id', 'unknown')
        event_kind = event.get('kind', 0)

        logger.info(f"Processing event {event_id} (kind {event_kind})")

        # Allow certain event kinds without ecash validation
        # 11998: DVM heartbeats
        # 0: Metadata
        # 1: Text notes (can optionally require payment later)
        # 10002: Relay list metadata
        EXEMPT_KINDS = [0, 3, 10002, 11998]

        if event_kind in EXEMPT_KINDS:
            logger.info(f"Event kind {event_kind} is exempt from ecash validation")
            self.stats['accepted'] += 1
            return {
                "id": event_id,
                "action": "accept",
                "msg": ""
            }

        # Extract ecash token from event
        token = self.extract_token_from_event(event)

        if not token:
            # No token found - reject the event
            self.stats['rejected'] += 1
            return {
                "id": event_id,
                "action": "reject",
                "msg": "blocked: ecash token required"
            }

        # Validate token with mint
        is_valid, message, validation_time = await self.validate_token_with_mint(token)
        self.stats['validation_times'].append(validation_time)

        if is_valid:
            self.stats['accepted'] += 1
            logger.info(f"Event {event_id} accepted - valid ecash token ({validation_time:.2f}ms)")
            return {
                "id": event_id,
                "action": "accept",
                "msg": ""
            }
        else:
            self.stats['rejected'] += 1
            logger.warning(f"Event {event_id} rejected - {message}")
            return {
                "id": event_id,
                "action": "reject",
                "msg": f"blocked: {message}"
            }

    async def run(self):
        """
        Main plugin loop - read events from stdin, validate, write to stdout.
        """
        logger.info("Ecash validator plugin started")

        try:
            # Read from stdin line by line
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue

                try:
                    # Parse input JSON
                    input_msg = json.loads(line)

                    # Process the event
                    response = await self.process_event(input_msg)

                    # Write response to stdout
                    print(json.dumps(response), flush=True)

                    # Log statistics periodically
                    if self.stats['total_events'] % 100 == 0:
                        avg_time = sum(self.stats['validation_times']) / len(self.stats['validation_times']) if self.stats['validation_times'] else 0
                        logger.info(f"Stats: {self.stats['total_events']} events, "
                                   f"{self.stats['accepted']} accepted, "
                                   f"{self.stats['rejected']} rejected, "
                                   f"avg validation time: {avg_time:.2f}ms")

                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse input JSON: {e}")
                    # Send a generic rejection for malformed input
                    print(json.dumps({
                        "id": "unknown",
                        "action": "reject",
                        "msg": "blocked: invalid input"
                    }), flush=True)

                except Exception as e:
                    logger.error(f"Error processing event: {e}")
                    # Send a generic rejection for processing errors
                    print(json.dumps({
                        "id": "unknown",
                        "action": "reject",
                        "msg": f"blocked: processing error"
                    }), flush=True)

        finally:
            logger.info("Ecash validator plugin stopped")

async def main():
    """Main entry point."""
    validator = EcashValidator()
    await validator.run()

if __name__ == "__main__":
    # Run the async main function
    asyncio.run(main())