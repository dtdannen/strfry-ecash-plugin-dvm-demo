'use client'

import { useState, useEffect, useRef } from 'react'
import {
  SimplePool,
  type Event as NostrEvent,
  type Filter,
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip19
} from 'nostr-tools'

interface DVMConfig {
  npub: string
  pubkeyHex: string
  relayUrl: string
}

interface HeartbeatInfo {
  timestamp: number
  status: string
}

interface JobRequest {
  id: string
  input: string
  timestamp: number
  responseReceived: boolean
  responseTime?: number
  responseContent?: string
  status?: string
}

export default function DVMTester() {
  // Connection state
  const [connected, setConnected] = useState(false)
  const [relayUrl] = useState('ws://localhost:7788')

  // DVM monitoring - Configuration from environment variables (required)
  const dvmNpub = process.env.NEXT_PUBLIC_DVM_NPUB
  const dvmPubkeyHex = process.env.NEXT_PUBLIC_DVM_PUBKEY_HEX
  const dvmRelayUrl = process.env.NEXT_PUBLIC_RELAY_URL

  if (!dvmNpub || !dvmPubkeyHex || !dvmRelayUrl) {
    throw new Error('DVM configuration environment variables are required: NEXT_PUBLIC_DVM_NPUB, NEXT_PUBLIC_DVM_PUBKEY_HEX, NEXT_PUBLIC_RELAY_URL')
  }

  const [dvmConfig] = useState<DVMConfig>({
    npub: dvmNpub,
    pubkeyHex: dvmPubkeyHex,
    relayUrl: dvmRelayUrl
  })
  const [dvmConfigLoading] = useState(false)
  const [dvmConfigError] = useState('')
  const [lastHeartbeat, setLastHeartbeat] = useState<HeartbeatInfo | null>(null)

  // Manual test
  const [testInput, setTestInput] = useState('')
  const [requestType, setRequestType] = useState<'open' | 'targeted'>('targeted')
  const [manualLoading, setManualLoading] = useState(false)
  const [lastRequest, setLastRequest] = useState<JobRequest | null>(null)
  const lastRequestRef = useRef<JobRequest | null>(null)

  // Performance test
  const [perfRequestCount, setPerfRequestCount] = useState(2) // 0=10, 1=100, 2=1000
  const [perfRunning, setPerfRunning] = useState(false)
  const [perfProgress, setPerfProgress] = useState(0)
  const [perfRequests, setPerfRequests] = useState<JobRequest[]>([])
  const [perfElapsedTime, setPerfElapsedTime] = useState(0)

  // Nostr client
  const poolRef = useRef<SimplePool | null>(null)
  const clientKeysRef = useRef<{ secretKey: Uint8Array; publicKey: string } | null>(null)
  const subscriptionsRef = useRef<string[]>([])

  // Get actual request count from slider value
  const getRequestCount = () => Math.pow(10, perfRequestCount + 1)

  // Initialize Nostr client and connect to relay
  useEffect(() => {
    // Generate client keys
    const secretKey = generateSecretKey()
    const publicKey = getPublicKey(secretKey)
    clientKeysRef.current = { secretKey, publicKey }

    console.log('Client npub:', nip19.npubEncode(publicKey))

    // Initialize pool
    poolRef.current = new SimplePool()

    // Connect to relay
    connectToRelay()

    return () => {
      // Cleanup subscriptions
      if (poolRef.current && subscriptionsRef.current.length > 0) {
        subscriptionsRef.current.forEach(subId => {
          // SimplePool doesn't expose close by ID, so we just clear the ref
        })
      }
    }
  }, [])

  const connectToRelay = async () => {
    if (!poolRef.current || !clientKeysRef.current) return

    try {
      console.log('Connecting to relay:', relayUrl)

      // Test connection by subscribing to a simple filter
      const testFilter: Filter = {
        kinds: [1],
        limit: 1
      }

      console.log('Test filter:', JSON.stringify(testFilter))

      // @ts-ignore - nostr-tools type signature
      poolRef.current.subscribe(
        [relayUrl],
        testFilter,  // Pass filter directly, not as array
        {
          onevent: () => {
            // Got an event, connection works
            console.log('Test subscription received event, marking as connected')
            setConnected(true)
          },
          oneose: () => {
            console.log('Test subscription EOSE received, marking as connected')
            setConnected(true)
          }
        }
      )

      console.log('Test subscription created')

      // Don't call setupDVMSubscriptions here - it will be called by useEffect when dvmConfig loads

    } catch (error) {
      console.error('Failed to connect to relay:', error)
      setConnected(false)
    }
  }

  const setupDVMSubscriptions = () => {
    if (!poolRef.current || !clientKeysRef.current || !dvmConfig) {
      console.log('setupDVMSubscriptions skipped:', {
        hasPool: !!poolRef.current,
        hasKeys: !!clientKeysRef.current,
        hasDvmConfig: !!dvmConfig
      })
      return
    }

    const dvmPubkeyHex = dvmConfig.pubkeyHex
    console.log('Setting up DVM subscriptions for pubkey:', dvmPubkeyHex)
    console.log('Client pubkey:', clientKeysRef.current.publicKey)

    // Subscribe to heartbeats from DVM (kind 11998)
    const heartbeatFilter: Filter = {
      kinds: [11998],
      authors: [dvmPubkeyHex],
      since: Math.floor(Date.now() / 1000)
    }

    console.log('Subscribing to heartbeats with filter:', heartbeatFilter)

    try {
      console.log('Heartbeat filter object (not array!):', JSON.stringify(heartbeatFilter))

      // Use subscribe (not subscribeMany) with a single filter object
      // @ts-ignore - nostr-tools type signature issue
      const heartbeatSub = (poolRef.current as any).subscribe(
        [relayUrl],
        heartbeatFilter,  // Pass filter directly, not as array
        {
          onevent: (event: NostrEvent) => {
            console.log('Received heartbeat:', event)
            setLastHeartbeat({
              timestamp: event.created_at,
              status: event.content
            })
          },
          oneose: () => {
            console.log('Heartbeat subscription EOSE received')
          }
        }
      )
      console.log('Heartbeat subscription created')
    } catch (e) {
      console.error('Error creating heartbeat subscription:', e)
    }

    // Subscribe to DVM responses (kind 25000) to our requests
    const responseFilter: Filter = {
      kinds: [25000],
      authors: [dvmPubkeyHex],
      '#p': [clientKeysRef.current.publicKey],
      since: Math.floor(Date.now() / 1000)
    }

    console.log('Subscribing to DVM responses with filter:', responseFilter)

    try {
      console.log('Response filter object (not array!):', JSON.stringify(responseFilter))

      // Use subscribe (not subscribeMany) with a single filter object
      // @ts-ignore - nostr-tools type signature issue
      const responseSub = (poolRef.current as any).subscribe(
        [relayUrl],
        responseFilter,  // Pass filter directly, not as array
        {
          onevent: (event: NostrEvent) => {
            console.log('Received DVM response:', event)
            handleDVMResponse(event)
          },
          oneose: () => {
            console.log('Response subscription EOSE received')
          }
        }
      )
      console.log('Response subscription created')
    } catch (e) {
      console.error('Error creating response subscription:', e)
    }
  }

  // Re-setup subscriptions when DVM config loads
  useEffect(() => {
    if (dvmConfig && connected) {
      setupDVMSubscriptions()
    }
  }, [dvmConfig, connected])

  const handleDVMResponse = (event: NostrEvent) => {
    console.log('handleDVMResponse called with event:', event)

    // Extract the request ID from e tag
    const eTag = event.tags.find(tag => tag[0] === 'e')
    if (!eTag || !eTag[1]) {
      console.log('No e-tag found in response, skipping')
      return
    }

    const requestId = eTag[1]
    const responseTime = Date.now()

    console.log('Response for request ID:', requestId)
    console.log('Current lastRequest:', lastRequest)
    console.log('Current lastRequestRef:', lastRequestRef.current)

    // Extract status
    const statusTag = event.tags.find(tag => tag[0] === 'status')
    const status = statusTag?.[1] || 'unknown'

    // Check both ref and state for the request
    const currentRequest = lastRequestRef.current || lastRequest

    // Update manual request if it matches
    if (currentRequest && currentRequest.id === requestId) {
      console.log('Updating request with response')
      const updatedRequest = {
        ...currentRequest,
        responseReceived: true,
        responseTime: responseTime - currentRequest.timestamp,
        responseContent: event.content,
        status
      }

      // Update both ref and state
      lastRequestRef.current = updatedRequest
      setLastRequest(updatedRequest)
    } else {
      console.log('Response does not match current request')
    }

    // Update performance test requests
    setPerfRequests(prev => prev.map(req =>
      req.id === requestId
        ? {
            ...req,
            responseReceived: true,
            responseTime: responseTime - req.timestamp,
            responseContent: event.content,
            status
          }
        : req
    ))
  }

  const sendJobRequest = async (input: string, isTargeted: boolean): Promise<string | null> => {
    if (!poolRef.current || !clientKeysRef.current) {
      console.error('Client not initialized')
      return null
    }

    const tags: string[][] = [
      ['i', input, 'text/plain'],
      ['category', 'echo'],
      ['t', 'echo']
    ]

    if (isTargeted && dvmConfig) {
      tags.push(['p', dvmConfig.pubkeyHex])
    }

    const event = finalizeEvent({
      kind: 25000,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: `Job request: ${input}`
    }, clientKeysRef.current.secretKey)

    try {
      await poolRef.current.publish([relayUrl], event)
      console.log('Published job request:', event)
      return event.id
    } catch (error) {
      console.error('Failed to publish event:', error)
      return null
    }
  }

  const handleManualTest = async () => {
    if (!testInput.trim()) return

    if (!dvmConfig) {
      console.error('DVM config not loaded yet')
      return
    }

    setManualLoading(true)

    // Small delay to ensure subscriptions are fully established
    await new Promise(resolve => setTimeout(resolve, 100))

    const eventId = await sendJobRequest(testInput, requestType === 'targeted')

    if (eventId) {
      const requestObj = {
        id: eventId,
        input: testInput,
        timestamp: Date.now(),
        responseReceived: false
      }

      // Set both ref (immediate) and state (async)
      lastRequestRef.current = requestObj
      setLastRequest(requestObj)

      console.log('Request set with ID:', eventId)
    }

    setManualLoading(false)
  }

  const handlePerfTest = async () => {
    const count = getRequestCount()
    setPerfRunning(true)
    setPerfProgress(0)
    setPerfRequests([])
    setPerfElapsedTime(0)

    // Capture start time in a local variable to avoid closure issue
    const startTime = Date.now()

    // Start timer - using local startTime variable instead of state
    const timerInterval = setInterval(() => {
      setPerfElapsedTime((Date.now() - startTime) / 1000)
    }, 100)

    const requests: JobRequest[] = []

    try {
      for (let i = 0; i < count; i++) {
        const input = `Test message ${i + 1}`
        const eventId = await sendJobRequest(input, true)

        if (eventId) {
          requests.push({
            id: eventId,
            input,
            timestamp: Date.now(),
            responseReceived: false
          })
          setPerfProgress(i + 1)
          setPerfRequests([...requests])
        }

        // Yield control back to React periodically to allow UI updates
        // For small counts, yield every request; for large counts, yield every 10
        const yieldFrequency = count <= 100 ? 1 : 10
        if ((i + 1) % yieldFrequency === 0) {
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }

      console.log(`Sent ${requests.length} job requests`)
    } catch (error) {
      console.error('Performance test error:', error)
    } finally {
      // Force one final update of elapsed time before clearing
      setPerfElapsedTime((Date.now() - startTime) / 1000)
      clearInterval(timerInterval)
      setPerfRunning(false)
    }
  }

  // Calculate performance metrics
  const completedRequests = perfRequests.filter(r => r.responseReceived)
  const avgResponseTime = completedRequests.length > 0
    ? completedRequests.reduce((sum, r) => sum + (r.responseTime || 0), 0) / completedRequests.length
    : 0

  return (
    <main className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-100 p-8">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* DVM Status - Combined Connection and Configuration */}
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-2xl font-bold text-gray-800 mb-4">
            DVM Status
          </h2>

          {/* Connection Info */}
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div>
              <p className="text-sm text-gray-600">Relay URL</p>
              <p className="font-mono text-sm">{relayUrl}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Connection</p>
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="font-semibold">{connected ? 'Connected' : 'Disconnected'}</span>
              </div>
            </div>
          </div>

          {dvmConfigLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="text-gray-600">Loading DVM configuration...</div>
            </div>
          )}

          {dvmConfigError && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
              <p className="font-semibold">Error loading DVM configuration</p>
              <p className="text-sm mt-1">{dvmConfigError}</p>
              <p className="text-sm mt-2">Make sure the DVM container is running: <code className="bg-red-200 px-1 rounded">docker compose up dvm-echo -d</code></p>
            </div>
          )}

          {dvmConfig && (
            <>
              {/* DVM Info */}
              <div className="border-t pt-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      DVM Public Key (npub)
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={dvmConfig.npub}
                        readOnly
                        className="flex-1 px-2 py-1 border border-gray-300 rounded font-mono text-xs bg-gray-50"
                      />
                      <button
                        onClick={() => navigator.clipboard.writeText(dvmConfig.npub)}
                        className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Last Heartbeat
                    </label>
                    {lastHeartbeat ? (
                      <div>
                        <p className="font-mono text-lg">{new Date(lastHeartbeat.timestamp * 1000).toLocaleTimeString()}</p>
                        <p className="text-xs text-gray-500">Status: {lastHeartbeat.status}</p>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500">Waiting for heartbeat...</p>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Manual Test */}
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-2xl font-bold text-gray-800 mb-4">
            Manual Test
          </h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Request Type
              </label>
              <div className="flex gap-4">
                <label className="flex items-center">
                  <input
                    type="radio"
                    value="targeted"
                    checked={requestType === 'targeted'}
                    onChange={(e) => setRequestType(e.target.value as 'open' | 'targeted')}
                    className="mr-2"
                  />
                  Targeted (p-tag)
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    value="open"
                    checked={requestType === 'open'}
                    onChange={(e) => setRequestType(e.target.value as 'open' | 'targeted')}
                    className="mr-2"
                  />
                  Open (hashtag only)
                </label>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Message to Echo
              </label>
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
              disabled={manualLoading || !testInput.trim() || !connected}
              className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-3 px-4 rounded-lg transition duration-200"
            >
              {manualLoading ? 'Sending...' : 'Send Job Request'}
            </button>

            {lastRequest && (
              <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                <h3 className="font-semibold mb-2">Last Request</h3>
                <div className="space-y-1 text-sm">
                  <p><span className="text-gray-600">Input:</span> {lastRequest.input}</p>
                  <p><span className="text-gray-600">Event ID:</span> <code className="text-xs">{lastRequest.id.slice(0, 16)}...</code></p>
                  <p><span className="text-gray-600">Status:</span> {
                    lastRequest.responseReceived
                      ? <span className="text-green-600 font-semibold">✓ Response received</span>
                      : <span className="text-yellow-600">⏳ Waiting for response...</span>
                  }</p>
                  {lastRequest.responseReceived && (
                    <>
                      <p><span className="text-gray-600">Response:</span> {lastRequest.responseContent}</p>
                      <p><span className="text-gray-600">Response Time:</span> {lastRequest.responseTime}ms</p>
                      <p><span className="text-gray-600">Status:</span> {lastRequest.status}</p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Performance Test */}
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-2xl font-bold text-gray-800 mb-4">
            Performance Testing
          </h2>

          {/* Request Count Slider */}
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Number of requests: <span className="text-purple-600 font-bold text-lg">{getRequestCount().toLocaleString()}</span>
            </label>
            <input
              type="range"
              min="0"
              max="4"
              value={perfRequestCount}
              onChange={(e) => {
                setPerfRequestCount(parseInt(e.target.value))
                setPerfProgress(0)
                setPerfRequests([])
                setPerfElapsedTime(0)
              }}
              disabled={perfRunning}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer disabled:opacity-50"
              style={{
                background: perfRunning ? undefined : `linear-gradient(to right, #9333ea 0%, #9333ea ${(perfRequestCount / 4) * 100}%, #e5e7eb ${(perfRequestCount / 4) * 100}%, #e5e7eb 100%)`
              }}
            />
            <div className="flex justify-between text-xs text-gray-500 mt-2">
              <span>10</span>
              <span>100</span>
              <span>1K</span>
              <span>10K</span>
              <span>100K</span>
            </div>
          </div>

          <button
            onClick={handlePerfTest}
            disabled={perfRunning || !connected || !dvmConfig}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-3 px-4 rounded-lg transition duration-200 mb-4"
          >
            {perfRunning ? 'Running...' : `Send ${getRequestCount().toLocaleString()} Job Requests`}
          </button>

          {perfProgress > 0 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-gray-600">
                  <span>Sent: {perfProgress.toLocaleString()}/{getRequestCount().toLocaleString()}</span>
                  <span>
                    Time: {perfElapsedTime.toFixed(1)}s
                    {perfElapsedTime > 0 && (
                      <span className="ml-1">
                        ({(perfProgress / (perfElapsedTime * 1000)).toFixed(2)} sent/ms, {(completedRequests.length / (perfElapsedTime * 1000)).toFixed(2)} completed/ms)
                      </span>
                    )}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-4">
                  <div
                    className="bg-blue-600 h-4 rounded-full transition-all duration-200"
                    style={{ width: `${(perfProgress / getRequestCount()) * 100}%` }}
                  />
                </div>
              </div>

              <div className="grid md:grid-cols-3 gap-4 text-sm bg-gray-50 p-4 rounded-lg">
                <div>
                  <p className="text-gray-600">Responses Received</p>
                  <p className="text-lg font-semibold">{completedRequests.length.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-gray-600">Success Rate</p>
                  <p className="text-lg font-semibold">
                    {perfProgress > 0 ? ((completedRequests.length / perfProgress) * 100).toFixed(1) : 0}%
                  </p>
                </div>
                <div>
                  <p className="text-gray-600">Avg Response Time</p>
                  <p className="text-lg font-semibold">{avgResponseTime.toFixed(0)} ms</p>
                </div>
              </div>
            </div>
          )}
        </div>

      </div>
    </main>
  )
}
