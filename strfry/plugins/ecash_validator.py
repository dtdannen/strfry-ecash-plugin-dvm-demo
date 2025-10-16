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
from typing import Dict, Any, Optional, List
import re
import base64
from cashu.wallet.wallet import Wallet

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
        Validate and spend token with CDK mint using Cashu wallet.
        Returns (is_valid, message, validation_time_ms)
        """
        start_time = time.time()

        try:
            # Initialize wallet with our mint
            # Cashu 0.17.0 requires a database path
            wallet = Wallet(MINT_URL, db="/tmp/ecash_validator_wallet.db")

            # Load mint info (keyset, etc.)
            await wallet.load_mint()

            # Try to receive (spend) the token
            # This will validate and redeem it with the mint
            proofs = await wallet.receive(token)

            validation_time = (time.time() - start_time) * 1000  # Convert to ms

            if proofs:
                # Token was valid and successfully spent
                total_amount = sum(p.amount for p in proofs)

                if total_amount >= REQUIRED_SATS:
                    logger.info(f"Token validated successfully: {total_amount} sats in {validation_time:.2f}ms")
                    return True, f"Token valid: {total_amount} sats", validation_time
                else:
                    logger.warning(f"Token value too low: {total_amount} sats < {REQUIRED_SATS} required")
                    return False, f"Token value too low: {total_amount} sats", validation_time
            else:
                logger.warning("Token validation failed: no proofs returned")
                return False, "Token invalid or already spent", validation_time

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