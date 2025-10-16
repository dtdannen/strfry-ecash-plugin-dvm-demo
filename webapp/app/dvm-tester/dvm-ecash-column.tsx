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
import { CashuMint, CashuWallet, getEncodedToken } from '@cashu/cashu-ts'

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
  // DVM configuration - will be updated once DVM starts
  const [dvmConfig, setDvmConfig] = useState<DVMEcashConfig>({
    npub: 'pending...',
    pubkeyHex: '',
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

  // Token minting state
  const [mintingToken, setMintingToken] = useState(false)

  // Mint functions
  const mintToken = async (amount: number = 1): Promise<{ token: string; amount: number } | null> => {
    try {
      const mint = new CashuMint(dvmConfig.mintUrl)
      const wallet = new CashuWallet(mint)
      await wallet.loadMint()

      // Create a mint quote
      const mintQuote = await wallet.createMintQuote(amount)

      // Check payment (fake wallet auto-pays)
      await wallet.checkMintQuote(mintQuote.quote)

      // Mint the token
      const proofs = await wallet.mintProofs(amount, mintQuote.quote)

      // Create encoded token
      const token = getEncodedToken({
        token: [{
          mint: dvmConfig.mintUrl,
          proofs
        }]
      })

      return { token, amount }
    } catch (error) {
      console.error('Error minting token:', error)
      return null
    }
  }

  // Handle manual test
  const handleManualTest = async () => {
    if (!pool || !connected || !testInput.trim() || !clientKeys) {
      return
    }

    setManualLoading(true)

    try {
      // First, mint a token
      setMintingToken(true)
      const tokenData = await mintToken(1)
      setMintingToken(false)

      if (!tokenData) {
        throw new Error('Failed to mint token')
      }

      const startTime = Date.now()

      // Create the DVM request with ecash token
      const unsignedEvent = {
        kind: 25000,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['i', testInput],
          ['ecash', tokenData.token]
        ],
        content: `Echo request: ${testInput}`,
        pubkey: clientKeys.publicKey
      }

      const signedEvent = finalizeEvent(unsignedEvent, clientKeys.secretKey)

      // For encrypted ecash DVM, we need to get the pubkey from heartbeat
      if (!dvmConfig.pubkeyHex) {
        console.error('DVM public key not yet available from heartbeat')
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
        JSON.stringify(signedEvent)
      )

      // Send the encrypted request
      await pool.publish([relayUrl], giftWrap)

      const newRequest: JobRequest = {
        id: signedEvent.id,
        input: testInput,
        timestamp: Date.now(),
        responseReceived: false,
        isEncrypted: true,
        token: tokenData.token,
        tokenAmount: tokenData.amount
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

  // Handle performance test
  const handlePerformanceTest = async () => {
    if (!pool || !connected || perfRunning || !clientKeys) {
      return
    }

    setPerfRunning(true)
    setPerfProgress(0)
    setPerfRequests([])
    perfRequestsRef.current = []
    setPerfBatchMinting(true)

    const startTime = Date.now()
    const BATCH_SIZE = 100 // Process in batches to avoid overwhelming

    try {
      // Pre-mint all tokens for performance test
      console.log(`Pre-minting ${perfRequestCount} tokens...`)
      const tokens: { token: string; amount: number }[] = []

      // Mint tokens in batches
      const mintBatches = Math.ceil(perfRequestCount / BATCH_SIZE)
      for (let batch = 0; batch < mintBatches; batch++) {
        const batchStart = batch * BATCH_SIZE
        const batchEnd = Math.min((batch + 1) * BATCH_SIZE, perfRequestCount)
        const batchPromises = []

        for (let i = batchStart; i < batchEnd; i++) {
          batchPromises.push(mintToken(1))
        }

        const batchResults = await Promise.all(batchPromises)
        tokens.push(...batchResults.filter((t): t is { token: string; amount: number } => t !== null))
        setPerfProgress((tokens.length / perfRequestCount) * 0.5) // First 50% is minting
      }

      setPerfBatchMinting(false)
      console.log(`Minted ${tokens.length} tokens, sending requests...`)

      // Send all requests in batches
      const requests: JobRequest[] = []
      const sendBatches = Math.ceil(tokens.length / BATCH_SIZE)

      for (let batch = 0; batch < sendBatches; batch++) {
        const batchStart = batch * BATCH_SIZE
        const batchEnd = Math.min((batch + 1) * BATCH_SIZE, tokens.length)
        const batchPromises = []

        for (let i = batchStart; i < batchEnd; i++) {
          const input = `Perf test ${i + 1}/${perfRequestCount}`

          const unsignedEvent = {
            kind: 25000,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ['i', input],
              ['ecash', tokens[i].token]
            ],
            content: `Performance test: ${input}`,
            pubkey: clientKeys.publicKey
          }

          const signedEvent = finalizeEvent(unsignedEvent, clientKeys.secretKey)

          // Encrypt the request
          // Convert secretKey Uint8Array to hex string
          const secretKeyHex = Array.from(clientKeys.secretKey)
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('')

          const encryptPromise = encryptNip17Message(
            secretKeyHex,
            dvmConfig.pubkeyHex,
            JSON.stringify(signedEvent)
          ).then(({ giftWrap }) => {
            return Promise.all(pool.publish([relayUrl], giftWrap)).then(() => {
              const newRequest: JobRequest = {
                id: signedEvent.id,
                input,
                timestamp: Date.now(),
                responseReceived: false,
                isEncrypted: true,
                isPerfTest: true,
                token: tokens[i].token,
                tokenAmount: tokens[i].amount
              }
              return newRequest
            })
          })

          batchPromises.push(encryptPromise)
        }

        const batchRequests = await Promise.all(batchPromises)
        requests.push(...batchRequests)
        setPerfProgress(0.5 + ((requests.length / tokens.length) * 0.5)) // Second 50% is sending

        // Small delay between batches to avoid overwhelming
        if (batch < sendBatches - 1) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }

      setPerfRequests(requests)
      perfRequestsRef.current = requests
      setPerfElapsedTime((Date.now() - startTime) / 1000)

      console.log(`Sent ${requests.length} encrypted ecash requests`)

    } catch (error) {
      console.error('Performance test error:', error)
      setPerfBatchMinting(false)
    } finally {
      setPerfRunning(false)
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

                  const updatedRequests = perfRequestsRef.current.map(req => {
                    if (req.id === requestId && !req.responseReceived) {
                      return {
                        ...req,
                        responseReceived: true,
                        responseTime: Date.now() - req.timestamp,
                        responseContent: decrypted.content,
                        status: decrypted.tags.find((t: string[]) => t[0] === 'status')?.[1]
                      }
                    }
                    return req
                  })

                  perfRequestsRef.current = updatedRequests
                  setPerfRequests(updatedRequests)

                  const completed = updatedRequests.filter(r => r.responseReceived).length
                  if (completed === updatedRequests.length) {
                    const totalTime = Math.max(...updatedRequests.map(r => r.responseTime || 0))
                    setPerfElapsedTime(totalTime / 1000)
                  }
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

          <button
            onClick={handleManualTest}
            disabled={manualLoading || !testInput.trim() || !connected || mintingToken}
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition"
          >
            {mintingToken ? 'Minting Token...' : manualLoading ? 'Sending...' : 'Send Ecash Request (1 sat)'}
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
              onChange={(e) => setPerfRequestCount(parseInt(e.target.value))}
              disabled={perfRunning}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            >
              <option value="10">10 tokens</option>
              <option value="100">100 tokens</option>
              <option value="1000">1,000 tokens</option>
              <option value="10000">10,000 tokens</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Total cost: {perfRequestCount.toLocaleString()} sats
            </p>
          </div>

          <button
            onClick={handlePerformanceTest}
            disabled={perfRunning || !connected}
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition"
          >
            {perfRunning ? (
              perfBatchMinting
                ? `Minting tokens... (${Math.floor(perfProgress * 100)}%)`
                : `Sending requests... (${Math.floor(perfProgress * 100)}%)`
            ) : `Run Performance Test (${perfRequestCount.toLocaleString()} sats)`}
          </button>

          {perfRequests.length > 0 && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg">
              <h4 className="font-semibold mb-2">Performance Results</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-gray-600">Total Requests:</span>
                  <span className="ml-2 font-mono">{perfRequests.length}</span>
                </div>
                <div>
                  <span className="text-gray-600">Responses:</span>
                  <span className="ml-2 font-mono">
                    {perfRequests.filter(r => r.responseReceived).length}/{perfRequests.length}
                  </span>
                </div>
                <div>
                  <span className="text-gray-600">Total Cost:</span>
                  <span className="ml-2 font-mono">{perfRequests.length} sats</span>
                </div>
                <div>
                  <span className="text-gray-600">Elapsed:</span>
                  <span className="ml-2 font-mono">{perfElapsedTime.toFixed(2)}s</span>
                </div>
                {perfRequests.filter(r => r.responseReceived).length > 0 && (
                  <>
                    <div>
                      <span className="text-gray-600">Avg Response:</span>
                      <span className="ml-2 font-mono">
                        {(perfRequests.filter(r => r.responseReceived).reduce((sum, r) => sum + (r.responseTime || 0), 0) / perfRequests.filter(r => r.responseReceived).length).toFixed(0)}ms
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-600">Success Rate:</span>
                      <span className="ml-2 font-mono">
                        {((perfRequests.filter(r => r.responseReceived).length / perfRequests.length) * 100).toFixed(1)}%
                      </span>
                    </div>
                  </>
                )}
              </div>

              {perfProgress > 0 && perfProgress < 1 && (
                <div className="mt-4">
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-purple-600 h-2 rounded-full transition-all"
                      style={{ width: `${perfProgress * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {perfProgress < 0.5 ? 'Minting tokens...' : 'Sending requests...'}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}