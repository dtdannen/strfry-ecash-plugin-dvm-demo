/**
 * NIP-17 Gift Wrap Implementation for TypeScript
 *
 * This implements the NIP-17 specification for encrypted messages using gift wrap.
 * https://github.com/nostr-protocol/nips/blob/master/17.md
 */

import {
  type Event as NostrEvent,
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip44,
  type UnsignedEvent,
  getEventHash
} from 'nostr-tools'

// Helper function to convert hex string to Uint8Array
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)))
}

/**
 * Creates a NIP-17 gift-wrapped encrypted message
 *
 * @param senderPrivkey - The sender's private key (hex string)
 * @param recipientPubkey - The recipient's public key (hex string)
 * @param content - The message content
 * @param tags - Optional tags for the message
 * @param kind - The kind of the inner message (default: 25000 for DVM)
 * @param giftWrapTags - Optional additional tags for the gift wrap event (default: [])
 * @returns Object containing the gift wrap event and the unsigned message event ID
 */
export async function encryptNip17Message(
  senderPrivkey: string,
  recipientPubkey: string,
  content: string,
  tags: string[][] = [],
  kind: number = 25000,
  giftWrapTags: string[][] = []
): Promise<{ giftWrap: NostrEvent; unsignedEventId: string }> {
  // Convert hex private key to Uint8Array for nostr-tools
  const senderPrivkeyBytes = hexToBytes(senderPrivkey)
  const senderPubkey = getPublicKey(senderPrivkeyBytes)

  // Step 1: Create the message event (unsigned)
  const messageEvent: UnsignedEvent = {
    kind: kind,
    content: content,
    tags: tags,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: senderPubkey
  }

  // Calculate the ID of the unsigned event (this is what the DVM will reference)
  const unsignedEventId = getEventHash(messageEvent)

  // Convert to JSON for encryption
  const messageJson = JSON.stringify(messageEvent)

  // Step 2: Encrypt the message with sender's private key to recipient's public key
  const encryptedMessage = await nip44.encrypt(messageJson, nip44.getConversationKey(senderPrivkeyBytes, recipientPubkey))

  // Step 3: Create the seal event (kind 13) with encrypted message in content
  // Use random timestamp up to 2 days in the past for anonymity
  const randomSeconds = Math.floor(Math.random() * (2 * 24 * 60 * 60))
  const sealTimestamp = Math.floor(Date.now() / 1000) - randomSeconds

  const sealEvent: UnsignedEvent = {
    kind: 13,
    content: encryptedMessage,
    tags: [],
    created_at: sealTimestamp,
    pubkey: senderPubkey
  }

  // Sign the seal event
  const signedSealEvent = finalizeEvent(sealEvent, senderPrivkeyBytes)

  // Convert seal to JSON for encryption
  const sealJson = JSON.stringify(signedSealEvent)

  // Step 4 & 5: Encrypt seal and create gift wrap with SAME random key
  // Generate random keys ONCE for both operations
  const randomPrivkeyBytes = generateSecretKey()
  const randomPubkey = getPublicKey(randomPrivkeyBytes)

  // Encrypt the seal event with random key
  const encryptedSeal = await nip44.encrypt(sealJson, nip44.getConversationKey(randomPrivkeyBytes, recipientPubkey))

  // Create gift wrap with the SAME random keys
  // Random timestamp again for the gift wrap
  const giftWrapTimestamp = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * (2 * 24 * 60 * 60))

  const giftWrapEvent: UnsignedEvent = {
    kind: 1059,
    content: encryptedSeal,
    tags: [['p', recipientPubkey], ...giftWrapTags],
    created_at: giftWrapTimestamp,
    pubkey: randomPubkey
  }

  // Sign with the same random key
  const finalGiftWrap = finalizeEvent(giftWrapEvent, randomPrivkeyBytes)

  return {
    giftWrap: finalGiftWrap,
    unsignedEventId: unsignedEventId
  }
}

/**
 * Decrypts a NIP-17 gift-wrapped event
 *
 * @param recipientPrivkey - The recipient's private key (hex string)
 * @param giftWrapEvent - The gift wrap event to decrypt
 * @returns Object containing the decrypted message and real sender pubkey, or null if decryption fails
 */
export async function decryptNip17GiftWrap(
  recipientPrivkey: string,
  giftWrapEvent: NostrEvent
): Promise<{ message: UnsignedEvent; senderPubkey: string } | null> {
  try {
    // Convert hex private key to Uint8Array
    const recipientPrivkeyBytes = hexToBytes(recipientPrivkey)

    // Step 1: Check if this is a gift wrap event (kind 1059)
    if (giftWrapEvent.kind !== 1059) {
      console.error('Not a gift wrap event (kind 1059)')
      return null
    }

    // Step 2: Decrypt the gift wrap content to get seal event JSON
    const decryptedSealJson = await nip44.decrypt(
      giftWrapEvent.content,
      nip44.getConversationKey(recipientPrivkeyBytes, giftWrapEvent.pubkey)
    )

    // Step 3: Parse the seal event from JSON
    const sealEvent: NostrEvent = JSON.parse(decryptedSealJson)

    // Verify it's a seal event (kind 13)
    if (sealEvent.kind !== 13) {
      console.error('Decrypted content is not a seal event (kind 13)')
      return null
    }

    // Step 4: Decrypt the seal content to get original message JSON
    const decryptedMessageJson = await nip44.decrypt(
      sealEvent.content,
      nip44.getConversationKey(recipientPrivkeyBytes, sealEvent.pubkey)
    )

    // Step 5: Parse the message event from JSON
    const messageEvent: UnsignedEvent = JSON.parse(decryptedMessageJson)

    // The real sender is the author of the seal event
    const realSenderPubkey = sealEvent.pubkey

    return {
      message: messageEvent,
      senderPubkey: realSenderPubkey
    }
  } catch (error) {
    console.error('Failed to decrypt gift wrap:', error)
    return null
  }
}

/**
 * Helper function to check if an event is a gift wrap
 */
export function isGiftWrap(event: NostrEvent): boolean {
  return event.kind === 1059
}

/**
 * Helper function to check if a gift wrap is for a specific recipient
 */
export function isGiftWrapForRecipient(event: NostrEvent, recipientPubkey: string): boolean {
  if (!isGiftWrap(event)) return false

  // Check if the recipient's pubkey is in the p-tags
  return event.tags.some(tag =>
    tag.length >= 2 && tag[0] === 'p' && tag[1] === recipientPubkey
  )
}

/**
 * Extract input from a decrypted DVM job request
 */
export function extractInputFromEvent(event: UnsignedEvent): string {
  // Look for 'i' tag (input tag)
  const inputTag = event.tags.find(tag =>
    tag.length >= 2 && tag[0] === 'i'
  )

  if (inputTag && inputTag[1]) {
    return inputTag[1]
  }

  // Fallback to event content if no 'i' tag
  return event.content
}