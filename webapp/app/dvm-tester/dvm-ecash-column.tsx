'use client'

import { useState, useRef, useEffect } from 'react'
import {
  SimplePool,
  type Event as NostrEvent,
  type Filter,
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip19
} from 'nostr-tools'
import {
  encryptNip17Message,
  decryptNip17GiftWrap
} from '../../lib/nip17'
import { CashuMint, CashuWallet, getEncodedTokenV4, MintQuoteState } from '@cashu/cashu-ts'

interface DVMEcashConfig {
  npub: string
  pubkeyHex: string
  relayUrl: string
  label: string
  mintUrl: string
}

interface HeartbeatInfo {
  timestamp: number
  status: string
  encrypted?: boolean
  stats?: {
    requests: number
    valid_payments: number
    invalid_payments: number
    total_earned: string
    unique_users: number
  }
}

interface JobRequest {
  id: string
  input: string
  timestamp: number
  responseReceived: boolean
  responseTime?: number
  responseContent?: string
  status?: string
  isEncrypted?: boolean
  matchedRequestId?: string
  isPerfTest?: boolean
  token?: string
  tokenAmount?: number
}

interface DVMEcashColumnProps {
  pool: SimplePool | null
  connected: boolean
  clientKeys: { secretKey: Uint8Array; publicKey: string } | null
  relayUrl: string
}

export function DVMEcashColumn({ pool, connected, clientKeys, relayUrl }: DVMEcashColumnProps) {
  // DVM configuration - use environment variables
  const ecashDvmNpub = process.env.NEXT_PUBLIC_ECASH_DVM_NPUB || 'pending...'
  const ecashDvmPubkeyHex = process.env.NEXT_PUBLIC_ECASH_DVM_PUBKEY_HEX || ''

  console.log('Encrypted Ecash DVM Config from env:')
  console.log('  NPUB:', ecashDvmNpub)
  console.log('  Pubkey Hex:', ecashDvmPubkeyHex)

  const [dvmConfig, setDvmConfig] = useState<DVMEcashConfig>({
    npub: ecashDvmNpub,
    pubkeyHex: ecashDvmPubkeyHex,
    relayUrl: relayUrl,
    label: 'Encrypted Ecash DVM',
    mintUrl: 'http://localhost:8096'
  })

  // State
  const [lastHeartbeat, setLastHeartbeat] = useState<HeartbeatInfo | null>(null)
  const [testInput, setTestInput] = useState('')
  const [manualLoading, setManualLoading] = useState(false)
  const [lastRequest, setLastRequest] = useState<JobRequest | null>(null)
  const lastRequestRef = useRef<JobRequest | null>(null)

  // Performance test state
  const [perfRequestCount, setPerfRequestCount] = useState(10)
  const [perfRunning, setPerfRunning] = useState(false)
  const [perfProgress, setPerfProgress] = useState(0)
  const [perfRequests, setPerfRequests] = useState<JobRequest[]>([])
  const [perfElapsedTime, setPerfElapsedTime] = useState(0)
  const perfRequestsRef = useRef<JobRequest[]>([])
  const [perfBatchMinting, setPerfBatchMinting] = useState(false)

  // Performance test token management
  const [perfTokens, setPerfTokens] = useState<Array<{ relay: string; dvm: string }>>([])
  const [perfMintProgress, setPerfMintProgress] = useState(0)
  const [perfMinting, setPerfMinting] = useState(false)
  const [perfSendProgress, setPerfSendProgress] = useState(0)
  const [perfReceiveProgress, setPerfReceiveProgress] = useState(0)

  // Token wallet state
  const [tokenWallet, setTokenWallet] = useState<Array<{ token: string; amount: number; id: string }>>([])
  const [mintingBatch, setMintingBatch] = useState(false)
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null)

  // Token minting state
  const [mintingToken, setMintingToken] = useState(false)

  // Manual test token state
  const [relayToken, setRelayToken] = useState('')
  const [dvmToken, setDvmToken] = useState('')

  // Mint functions
  const mintToken = async (amount: number = 1): Promise<{ token: string; amount: number } | null> => {
    try {
      console.log('🪙 Starting token mint process...')
      console.log('   Mint URL:', dvmConfig.mintUrl)
      console.log('   Amount:', amount)

      const mint = new CashuMint(dvmConfig.mintUrl)
      const wallet = new CashuWallet(mint)
      await wallet.loadMint()
      console.log('✅ Mint loaded')

      // Create a mint quote
      console.log('📝 Creating mint quote...')
      const mintQuote = await wallet.createMintQuote(amount)
      console.log('📋 Mint quote created:', mintQuote)
      console.log('   Quote ID:', mintQuote.quote)
      console.log('   Full mintQuote object keys:', Object.keys(mintQuote))

      // Poll for payment (fake wallet auto-pays)
      console.log('⏳ Polling for payment...')
      let mintQuoteChecked
      let attempts = 0
      const maxAttempts = 30

      while (attempts < maxAttempts) {
        mintQuoteChecked = await wallet.checkMintQuote(mintQuote.quote)
        console.log(`   Attempt ${attempts + 1}:`, mintQuoteChecked)

        if (mintQuoteChecked.state === MintQuoteState.PAID) {
          console.log('✅ Payment confirmed!')
          break
        }

        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }

      if (!mintQuoteChecked || mintQuoteChecked.state !== MintQuoteState.PAID) {
        console.error('❌ Mint quote not paid in time')
        console.error('   Final state:', mintQuoteChecked?.state)
        console.error('   Attempts:', attempts)
        throw new Error('Mint quote not paid in time')
      }

      // Mint the token
      console.log('🔨 Minting proofs...')
      const proofs = await wallet.mintProofs(amount, mintQuote.quote)
      console.log('✅ Proofs minted:', proofs.length, 'proofs')

      // Create encoded token
      console.log('📦 Encoding token...')
      const token = getEncodedTokenV4({
        mint: dvmConfig.mintUrl,
        proofs: proofs
      })
      console.log('✅ Token created successfully')

      return { token, amount }
    } catch (error) {
      console.error('❌ Error minting token:', error)
      if (error instanceof Error) {
        console.error('   Error message:', error.message)
        console.error('   Error stack:', error.stack)
      }
      return null
    }
  }

  // Handle batch minting for wallet
  const handleMintTokens = async () => {
    setMintingBatch(true)
    try {
      const tokens: Array<{ token: string; amount: number; id: string }> = []
      for (let i = 0; i < 2; i++) {
        const tokenData = await mintToken(1)
        if (tokenData) {
          tokens.push({
            token: tokenData.token,
            amount: tokenData.amount,
            id: Math.random().toString(36).substr(2, 9)
          })
        }
      }

      // Populate relay and DVM token fields with the newly minted tokens
      if (tokens.length >= 2) {
        setRelayToken(tokens[0].token)
        setDvmToken(tokens[1].token)
      }

      setTokenWallet(prev => [...prev, ...tokens])
    } catch (error) {
      console.error('Error minting tokens:', error)
    } finally {
      setMintingBatch(false)
    }
  }

  // Copy token to clipboard
  const copyToken = (tokenId: string, token: string) => {
    navigator.clipboard.writeText(token)
    setCopiedTokenId(tokenId)
    setTimeout(() => setCopiedTokenId(null), 2000)
  }

  // Handle manual test
  const handleManualTest = async () => {
    if (!pool || !connected || !testInput.trim() || !clientKeys) {
      return
    }

    // Check if we have both tokens populated
    if (!relayToken || !dvmToken) {
      console.error('Both relay and DVM tokens required. Please mint tokens first.')
      return
    }

    setManualLoading(true)

    try {
      // Use the relay token and DVM token
      const relayTokenToUse = relayToken
      const dvmTokenToUse = dvmToken

      // Clear the token fields after use
      setRelayToken('')
      setDvmToken('')

      // Remove the first 2 tokens from wallet
      setTokenWallet(prev => prev.slice(2))

      const startTime = Date.now()

      // Create the DVM request with DVM ecash token
      const unsignedEvent = {
        kind: 25000,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['i', testInput],
          ['ecash', dvmTokenToUse]
        ],
        content: `Echo request: ${testInput}`,
        pubkey: clientKeys.publicKey
      }

      const signedEvent = finalizeEvent(unsignedEvent, clientKeys.secretKey)

      // For encrypted ecash DVM, we need the pubkey
      if (!dvmConfig.pubkeyHex) {
        console.error('DVM public key not available!')
        console.error('  dvmConfig.pubkeyHex:', dvmConfig.pubkeyHex)
        console.error('  dvmConfig.npub:', dvmConfig.npub)
        console.error('  Full dvmConfig:', dvmConfig)
        setManualLoading(false)
        return
      }

      // Encrypt the request
      // Convert secretKey Uint8Array to hex string
      const secretKeyHex = Array.from(clientKeys.secretKey)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')

      const { giftWrap } = await encryptNip17Message(
        secretKeyHex,
        dvmConfig.pubkeyHex,
        signedEvent.content,
        signedEvent.tags, // include the 'i' and 'ecash' tags
        25000, // kind
        [['ecash', relayTokenToUse]] // gift wrap tags with relay token
      )

      // Send the encrypted request with relay token in gift wrap
      await pool.publish([relayUrl], giftWrap)

      const newRequest: JobRequest = {
        id: signedEvent.id,
        input: testInput,
        timestamp: Date.now(),
        responseReceived: false,
        isEncrypted: true,
        token: `Relay: 1 sat, DVM: 1 sat`,
        tokenAmount: 2
      }

      setLastRequest(newRequest)
      lastRequestRef.current = newRequest

      console.log('Sent encrypted ecash DVM request:', signedEvent.id)

    } catch (error) {
      console.error('Error sending request:', error)
      setMintingToken(false)
    } finally {
      setManualLoading(false)
    }
  }

  // Handle minting tokens for performance test
  const handleMintPerfTokens = async () => {
    if (perfMinting) return

    setPerfMinting(true)
    setPerfMintProgress(0)
    setPerfTokens([])

    console.log(`Minting ${perfRequestCount * 2} tokens (${perfRequestCount} pairs)...`)
    const tokenPairs: Array<{ relay: string; dvm: string }> = []

    try {
      // Simple loop like homepage - no batching
      for (let i = 0; i < perfRequestCount; i++) {
        // Mint 2 tokens per request (relay + DVM)
        const relayToken = await mintToken(1)
        const dvmToken = await mintToken(1)

        if (relayToken && dvmToken) {
          tokenPairs.push({ relay: relayToken.token, dvm: dvmToken.token })
          setPerfMintProgress(i + 1)
        }
      }

      setPerfTokens(tokenPairs)
      console.log(`Successfully minted ${tokenPairs.length} token pairs (${tokenPairs.length * 2} total tokens)`)

    } catch (error) {
      console.error('Error minting performance test tokens:', error)
    } finally {
      setPerfMinting(false)
    }
  }

  // Handle performance test
  const handlePerformanceTest = async () => {
    if (!pool || !connected || perfRunning || !clientKeys || perfTokens.length === 0) {
      return
    }

    setPerfRunning(true)
    setPerfProgress(0)
    setPerfSendProgress(0)
    setPerfReceiveProgress(0)
    setPerfRequests([])
    perfRequestsRef.current = []

    const startTime = Date.now()
    const timerInterval = setInterval(() => {
      setPerfElapsedTime((Date.now() - startTime) / 1000)
    }, 100)

    try {
      console.log(`Sending ${perfTokens.length} requests using pre-minted tokens...`)

      // Simple loop like encrypted DVM test - no batching
      for (let i = 0; i < perfTokens.length; i++) {
        const input = `Perf test ${i + 1}/${perfTokens.length}`
        const tokenPair = perfTokens[i]

        const unsignedEvent = {
          kind: 25000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['i', input],
            ['ecash', tokenPair.dvm]
          ],
          content: `Performance test: ${input}`,
          pubkey: clientKeys.publicKey
        }

        const signedEvent = finalizeEvent(unsignedEvent, clientKeys.secretKey)

        // Encrypt the request
        const secretKeyHex = Array.from(clientKeys.secretKey)
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('')

        const { giftWrap } = await encryptNip17Message(
          secretKeyHex,
          dvmConfig.pubkeyHex,
          signedEvent.content,
          signedEvent.tags, // include the 'i' and 'ecash' tags
          25000, // kind
          [['ecash', tokenPair.relay]] // gift wrap tags with relay token
        )

        await pool.publish([relayUrl], giftWrap)

        const newRequest: JobRequest = {
          id: signedEvent.id,
          input,
          timestamp: Date.now(),
          responseReceived: false,
          isEncrypted: true,
          isPerfTest: true,
          token: `Relay: 1 sat, DVM: 1 sat`,
          tokenAmount: 2
        }

        perfRequestsRef.current.push(newRequest)
        setPerfRequests(prev => [...prev, newRequest])
        setPerfProgress(i + 1)
        setPerfSendProgress(i + 1)

        // Small delay like encrypted DVM test
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      console.log(`Sent ${perfTokens.length} encrypted ecash requests`)

      // Clear used tokens
      setPerfTokens([])

    } catch (error) {
      console.error('Performance test error:', error)
    } finally {
      setPerfRunning(false)

      const stopTimer = () => {
        setPerfElapsedTime((Date.now() - startTime) / 1000)
        clearInterval(timerInterval)
      }

      // Check for completion like encrypted DVM test
      const checkComplete = setInterval(() => {
        const totalReceived = perfRequestsRef.current.filter(r => r.responseReceived).length
        if (totalReceived === perfRequestsRef.current.length) {
          clearInterval(checkComplete)
          stopTimer()
        }
      }, 100)

      // Timeout after 60 seconds
      setTimeout(() => {
        clearInterval(checkComplete)
        stopTimer()
      }, 60000)
    }
  }

  // Listen for DVM responses
  useEffect(() => {
    if (!pool || !connected || !clientKeys) return

    // Subscribe to heartbeats
    const heartbeatSub = pool.subscribeMany(
      [relayUrl],
      {
        kinds: [11998]
      },
      {
        onevent: async (event: NostrEvent) => {
          // Handle heartbeat
          if (event.kind === 11998) {
            try {
              const content = JSON.parse(event.content)
              if (content.type === 'encrypted-ecash-echo') {
                setLastHeartbeat({
                  timestamp: event.created_at,
                  status: content.status,
                  encrypted: true,
                  stats: content.stats
                })

                // Update DVM pubkey if not set
                if (!dvmConfig.pubkeyHex && event.pubkey) {
                  const npub = nip19.npubEncode(event.pubkey)
                  setDvmConfig(prev => ({
                    ...prev,
                    pubkeyHex: event.pubkey,
                    npub: npub
                  }))
                  console.log('Updated encrypted ecash DVM config:', { npub, pubkey: event.pubkey })
                }
              }
            } catch (e) {
              console.error('Error parsing heartbeat:', e)
            }
          }
        }
      }
    )

    // Subscribe to gift wraps (NIP-17 encrypted responses)
    const giftWrapSub = pool.subscribeMany(
      [relayUrl],
      {
        kinds: [1059],
        '#p': [clientKeys.publicKey]
      },
      {
        onevent: async (event: NostrEvent) => {
          // Handle encrypted responses
          if (event.kind === 1059) {
            try {
              // Convert secretKey Uint8Array to hex string
              const secretKeyHex = Array.from(clientKeys.secretKey)
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('')

              const result = await decryptNip17GiftWrap(secretKeyHex, event)

              if (result && result.message && result.message.kind === 25000) {
                const decrypted = result.message
                const responseTime = Date.now() - (lastRequestRef.current?.timestamp || 0)

                // Update manual test response
                if (lastRequestRef.current && !lastRequestRef.current.isPerfTest) {
                  const requestId = decrypted.tags.find((t: string[]) => t[0] === 'e')?.[1]

                  if (requestId === lastRequestRef.current.id) {
                    const updatedRequest = {
                      ...lastRequestRef.current,
                      responseReceived: true,
                      responseTime,
                      responseContent: decrypted.content,
                      status: decrypted.tags.find((t: string[]) => t[0] === 'status')?.[1]
                    }
                    setLastRequest(updatedRequest)
                    lastRequestRef.current = updatedRequest
                    console.log('Received ecash DVM response:', responseTime, 'ms')
                  }
                }

                // Update performance test responses
                if (perfRequestsRef.current.length > 0) {
                  const requestId = decrypted.tags.find((t: string[]) => t[0] === 'e')?.[1]

                  const refRequest = perfRequestsRef.current.find(req => req.id === requestId)
                  if (refRequest && !refRequest.responseReceived) {
                    refRequest.responseReceived = true
                    refRequest.responseTime = Date.now() - refRequest.timestamp
                    refRequest.responseContent = decrypted.content
                    refRequest.status = decrypted.tags.find((t: string[]) => t[0] === 'status')?.[1]
                  }

                  setPerfRequests(prev => prev.map(req =>
                    req.id === requestId
                      ? {
                          ...req,
                          responseReceived: true,
                          responseTime: Date.now() - req.timestamp,
                          responseContent: decrypted.content,
                          status: decrypted.tags.find((t: string[]) => t[0] === 'status')?.[1]
                        }
                      : req
                  ))
                }
              }
            } catch (e) {
              console.error('Error decrypting response:', e)
            }
          }
        }
      }
    )

    return () => {
      heartbeatSub.close()
      giftWrapSub.close()
    }
  }, [pool, connected, clientKeys, relayUrl, dvmConfig.pubkeyHex])

  return (
    <div className="space-y-6">
      {/* Token Wallet Section */}
      <div className="bg-white rounded-lg shadow-lg p-6">
        <h3 className="text-xl font-bold mb-4 text-purple-600">Token Wallet</h3>

        <div className="space-y-2 mb-4">
          <div className="text-sm text-gray-600">
            Tokens Available: <span className="font-bold text-purple-600">{tokenWallet.length}</span>
          </div>
          <button
            onClick={handleMintTokens}
            disabled={mintingBatch}
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition"
          >
            {mintingBatch ? 'Minting...' : 'Mint 2 Tokens (2 sats)'}
          </button>
        </div>

        {tokenWallet.length > 0 ? (
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {tokenWallet.map((t, idx) => (
              <div key={t.id} className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs text-gray-600">Token #{idx + 1} ({t.amount} sat)</span>
                  <button
                    onClick={() => copyToken(t.id, t.token)}
                    className={`text-xs px-3 py-1 rounded transition ${
                      copiedTokenId === t.id
                        ? 'bg-green-500 text-white'
                        : 'bg-blue-500 hover:bg-blue-600 text-white'
                    }`}
                  >
                    {copiedTokenId === t.id ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div className="text-xs font-mono text-gray-500 break-all">
                  {t.token.substring(0, 20)}...{t.token.substring(t.token.length - 10)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
            <p className="font-medium">No tokens in wallet</p>
            <p className="text-sm mt-1">Click "Mint 2 Tokens" to get started</p>
          </div>
        )}
      </div>

      {/* Manual Test Section */}
      <div className="bg-white rounded-lg shadow-lg p-6">
        <h3 className="text-xl font-bold mb-4 text-purple-600">{dvmConfig.label}</h3>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">DVM Public Key</label>
              <input
                type="text"
                value={dvmConfig.npub}
                readOnly
                className="w-full px-2 py-1 border border-gray-300 rounded font-mono text-xs bg-gray-50"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-600 mb-1">Last Heartbeat</label>
              {lastHeartbeat ? (
                <div>
                  <p className="font-mono text-lg">{new Date(lastHeartbeat.timestamp * 1000).toLocaleTimeString()}</p>
                  {lastHeartbeat.stats && (
                    <div className="text-xs text-gray-500 space-y-1 mt-1">
                      <p>Earned: {lastHeartbeat.stats.total_earned}</p>
                      <p>Valid: {lastHeartbeat.stats.valid_payments} | Invalid: {lastHeartbeat.stats.invalid_payments}</p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-500">Waiting for heartbeat...</p>
              )}
            </div>
          </div>

          <div>
            <input
              type="text"
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !manualLoading) {
                  handleManualTest()
                }
              }}
              placeholder="Enter a message..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>

          {/* Ecash Token Fields */}
          <div className="space-y-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Relay Token (1 sat)
              </label>
              <input
                type="text"
                value={relayToken ? `${relayToken.substring(0, 20)}...${relayToken.substring(relayToken.length - 10)}` : ''}
                readOnly
                placeholder="Mint tokens to populate..."
                className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-xs font-mono text-gray-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                DVM Token (1 sat)
              </label>
              <input
                type="text"
                value={dvmToken ? `${dvmToken.substring(0, 20)}...${dvmToken.substring(dvmToken.length - 10)}` : ''}
                readOnly
                placeholder="Mint tokens to populate..."
                className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-xs font-mono text-gray-600"
              />
            </div>
          </div>

          <button
            onClick={handleManualTest}
            disabled={manualLoading || !testInput.trim() || !connected || !relayToken || !dvmToken}
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition"
          >
            {manualLoading ? 'Sending...' : (!relayToken || !dvmToken) ? 'Mint Tokens First' : `Send Request (uses 2 tokens)`}
          </button>

          {lastRequest && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg">
              <h4 className="font-semibold mb-2">Last Request</h4>
              <div className="space-y-1 text-sm">
                <p><span className="text-gray-600">Input:</span> {lastRequest.input}</p>
                <p><span className="text-gray-600">Token:</span> {lastRequest.tokenAmount} sat</p>
                <p><span className="text-gray-600">Status:</span> {
                  lastRequest.responseReceived
                    ? <span className="text-green-600 font-semibold">✓ Response received</span>
                    : <span className="text-yellow-600">⏳ Waiting...</span>
                }</p>
                {lastRequest.responseReceived && (
                  <>
                    <p><span className="text-gray-600">Response:</span> {lastRequest.responseContent}</p>
                    <p><span className="text-gray-600">Time:</span> {lastRequest.responseTime}ms</p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Performance Test Section */}
      <div className="bg-white rounded-lg shadow-lg p-6">
        <h3 className="text-xl font-bold mb-4 text-purple-600">Ecash Performance Test</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Number of Requests: <span className="font-mono text-purple-600">{perfRequestCount.toLocaleString()}</span>
            </label>
            <select
              value={perfRequestCount}
              onChange={(e) => {
                setPerfRequestCount(parseInt(e.target.value))
                setPerfTokens([]) // Clear tokens when count changes
              }}
              disabled={perfRunning || perfMinting}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            >
              <option value="10">10 requests</option>
              <option value="100">100 requests</option>
              <option value="1000">1,000 requests</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Total cost: {(perfRequestCount * 2).toLocaleString()} sats ({perfRequestCount} relay + {perfRequestCount} DVM)
            </p>
          </div>

          {/* Token Status Display */}
          {perfTokens.length > 0 && (
            <div className="p-3 bg-green-50 rounded-lg border border-green-200">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm font-semibold text-green-700">
                    ✓ {perfTokens.length} token pairs ready ({perfTokens.length * 2} total tokens)
                  </p>
                  <p className="text-xs text-green-600 mt-1">
                    Ready to send {perfTokens.length} encrypted requests
                  </p>
                </div>
                <button
                  onClick={() => setPerfTokens([])}
                  disabled={perfRunning}
                  className="text-xs px-3 py-1 bg-red-500 hover:bg-red-600 disabled:bg-gray-400 text-white rounded transition"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Mint Tokens Button */}
          <button
            onClick={handleMintPerfTokens}
            disabled={perfMinting || perfRunning || perfTokens.length > 0}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition"
          >
            {perfMinting
              ? `Minting tokens... (${Math.floor(perfMintProgress * 100)}%)`
              : perfTokens.length > 0
                ? 'Tokens Ready'
                : `Mint ${perfRequestCount * 2} Tokens (${perfRequestCount * 2} sats)`
            }
          </button>

          {/* Minting Progress Bar */}
          {perfMinting && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span>Minting Token Pairs</span>
                <span>{perfMintProgress}/{perfRequestCount}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-blue-600 h-3 rounded-full transition-all"
                  style={{ width: `${(perfMintProgress / perfRequestCount) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Run Performance Test Button */}
          <button
            onClick={handlePerformanceTest}
            disabled={perfRunning || !connected || perfTokens.length === 0 || perfMinting}
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition"
          >
            {perfRunning
              ? `Running test... (${Math.floor(perfProgress * 100)}%)`
              : perfTokens.length === 0
                ? 'Mint Tokens First'
                : `Run Performance Test (${perfRequestCount.toLocaleString()} requests)`
            }
          </button>

          {/* Send/Receive Progress Bars */}
          {perfProgress > 0 && (
            <div className="space-y-3">
              <div className="text-center text-sm text-gray-600">
                Time: {perfElapsedTime.toFixed(1)}s
              </div>

              {/* Send Progress */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span>Encrypting & Sending</span>
                  <span>{perfSendProgress}/{perfRequestCount}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all"
                    style={{ width: `${(perfSendProgress / perfRequestCount) * 100}%` }}
                  />
                </div>
              </div>

              {/* Receive Progress */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span>Decrypting & Receiving</span>
                  <span>{perfRequests.filter(r => r.responseReceived).length}/{perfRequestCount}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-green-600 h-2 rounded-full transition-all"
                    style={{ width: `${(perfRequests.filter(r => r.responseReceived).length / perfRequestCount) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Performance Results */}
          {perfProgress > 0 && (
            <div className="grid grid-cols-2 gap-2 text-sm bg-gray-50 p-3 rounded">
              <div>
                <p className="text-gray-600">Success Rate</p>
                <p className="font-semibold">
                  {perfProgress > 0 ? ((perfRequests.filter(r => r.responseReceived).length / perfProgress) * 100).toFixed(1) : 0}%
                </p>
              </div>
              <div>
                <p className="text-gray-600">Avg Time</p>
                <p className="font-semibold">
                  {perfRequests.filter(r => r.responseReceived).length > 0
                    ? (perfRequests.filter(r => r.responseReceived).reduce((sum, r) => sum + (r.responseTime || 0), 0) / perfRequests.filter(r => r.responseReceived).length).toFixed(0)
                    : 0} ms
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}