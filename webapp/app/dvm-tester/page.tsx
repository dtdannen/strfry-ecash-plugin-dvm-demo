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
import {
  encryptNip17Message,
  decryptNip17GiftWrap
} from '../../lib/nip17'
import { DVMEcashColumn } from './dvm-ecash-column'

interface DVMConfig {
  npub: string
  pubkeyHex: string
  relayUrl: string
  isEncrypted: boolean
  label: string
}

interface HeartbeatInfo {
  timestamp: number
  status: string
  encrypted?: boolean
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
}

export default function DVMTester() {
  // Connection state
  const [connected, setConnected] = useState(false)
  const [relayUrl] = useState(process.env.NEXT_PUBLIC_RELAY_URL || 'ws://localhost:7789')
  const [ecashRelayUrl] = useState(process.env.NEXT_PUBLIC_ECASH_RELAY_URL || 'ws://localhost:7788')

  // Plain DVM configuration from environment variables
  const plainDvmNpub = process.env.NEXT_PUBLIC_DVM_NPUB
  const plainDvmPubkeyHex = process.env.NEXT_PUBLIC_DVM_PUBKEY_HEX

  // Encrypted DVM configuration from environment variables (fallback to empty if not set)
  // Keys are dynamically loaded from DVM container on startup
  const encryptedDvmNpub = process.env.NEXT_PUBLIC_ENCRYPTED_DVM_NPUB || 'npub1s5q6q334a7590q9ngurddpf6czmw8kf8vr7kxg4u0p36qpt558aq23wlvr'
  const encryptedDvmPubkeyHex = process.env.NEXT_PUBLIC_ENCRYPTED_DVM_PUBKEY_HEX || '8501a04635efa85780b34706d6853ac0b6e3d92760fd6322bc7863a00574a1fa'

  if (!plainDvmNpub || !plainDvmPubkeyHex) {
    throw new Error('Plain DVM configuration environment variables are required: NEXT_PUBLIC_DVM_NPUB, NEXT_PUBLIC_DVM_PUBKEY_HEX')
  }

  // Both DVMs configuration
  const [plainDvmConfig] = useState<DVMConfig>({
    npub: plainDvmNpub,
    pubkeyHex: plainDvmPubkeyHex,
    relayUrl: relayUrl,
    isEncrypted: false,
    label: 'Plain DVM'
  })

  const [encryptedDvmConfig] = useState<DVMConfig>({
    npub: encryptedDvmNpub,
    pubkeyHex: encryptedDvmPubkeyHex,
    relayUrl: relayUrl,
    isEncrypted: true,
    label: 'Encrypted DVM (NIP-17)'
  })

  // Heartbeat state for both DVMs
  const [plainLastHeartbeat, setPlainLastHeartbeat] = useState<HeartbeatInfo | null>(null)
  const [encryptedLastHeartbeat, setEncryptedLastHeartbeat] = useState<HeartbeatInfo | null>(null)

  // Manual test state for plain DVM
  const [plainTestInput, setPlainTestInput] = useState('')
  const [plainRequestType, setPlainRequestType] = useState<'open' | 'targeted'>('targeted')
  const [plainManualLoading, setPlainManualLoading] = useState(false)
  const [plainLastRequest, setPlainLastRequest] = useState<JobRequest | null>(null)
  const plainLastRequestRef = useRef<JobRequest | null>(null)

  // Manual test state for encrypted DVM
  const [encryptedTestInput, setEncryptedTestInput] = useState('')
  const [encryptedManualLoading, setEncryptedManualLoading] = useState(false)
  const [encryptedLastRequest, setEncryptedLastRequest] = useState<JobRequest | null>(null)
  const encryptedLastRequestRef = useRef<JobRequest | null>(null)

  // Performance test state for plain DVM
  const [plainPerfRequestCount, setPlainPerfRequestCount] = useState(2)
  const [plainPerfMode, setPlainPerfMode] = useState<'sequential' | 'parallel'>('sequential')
  const [plainPerfRunning, setPlainPerfRunning] = useState(false)
  const [plainPerfProgress, setPlainPerfProgress] = useState(0)
  const [plainPerfRequests, setPlainPerfRequests] = useState<JobRequest[]>([])
  const plainPerfRequestsRef = useRef<JobRequest[]>([])
  const [plainPerfElapsedTime, setPlainPerfElapsedTime] = useState(0)
  const plainPerfTimingRef = useRef<{ firstSentAt: number; lastReceivedAt: number }>({ firstSentAt: 0, lastReceivedAt: 0 })
  const [plainPerfFinalMetrics, setPlainPerfFinalMetrics] = useState<{
    dvmType: string
    mode: 'sequential' | 'parallel'
    requestCount: number
    completedCount: number
    elapsedTime: number
    throughput?: number
    medianRTT: number
    avgRTT: number
    p95RTT: number
    modeRTT?: number
    timestamp: string
  } | null>(null)

  // Performance test state for encrypted DVM
  const [encryptedPerfRequestCount, setEncryptedPerfRequestCount] = useState(1) // Start lower for encrypted
  const [encryptedPerfMode, setEncryptedPerfMode] = useState<'sequential' | 'parallel'>('sequential')
  const [encryptedPerfRunning, setEncryptedPerfRunning] = useState(false)
  const [encryptedPerfProgress, setEncryptedPerfProgress] = useState(0)
  const [encryptedPerfRequests, setEncryptedPerfRequests] = useState<JobRequest[]>([])
  const encryptedPerfRequestsRef = useRef<JobRequest[]>([])
  const [encryptedPerfElapsedTime, setEncryptedPerfElapsedTime] = useState(0)
  const encryptedPerfTimingRef = useRef<{ firstSentAt: number; lastReceivedAt: number }>({ firstSentAt: 0, lastReceivedAt: 0 })
  const [encryptedPerfFinalMetrics, setEncryptedPerfFinalMetrics] = useState<{
    dvmType: string
    mode: 'sequential' | 'parallel'
    requestCount: number
    completedCount: number
    elapsedTime: number
    throughput?: number
    medianRTT: number
    avgRTT: number
    p95RTT: number
    modeRTT?: number
    timestamp: string
  } | null>(null)

  // Nostr client
  const poolRef = useRef<SimplePool | null>(null)
  const clientKeysRef = useRef<{ secretKey: Uint8Array; publicKey: string; privateKeyHex: string } | null>(null)
  const subscriptionsRef = useRef<string[]>([])

  // Helper functions
  const getRequestCount = (value: number) => Math.pow(10, value + 1)

  // Convert Uint8Array to hex string
  const bytesToHex = (bytes: Uint8Array): string => {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }

  // Initialize Nostr client and connect to relay
  useEffect(() => {
    // Generate client keys
    const secretKey = generateSecretKey()
    const publicKey = getPublicKey(secretKey)
    const privateKeyHex = bytesToHex(secretKey)

    clientKeysRef.current = { secretKey, publicKey, privateKeyHex }

    console.log('Client npub:', nip19.npubEncode(publicKey))
    console.log('Client pubkey hex:', publicKey)

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

      // @ts-ignore - nostr-tools type signature
      poolRef.current.subscribe(
        [relayUrl],
        testFilter,
        {
          onevent: () => {
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

    } catch (error) {
      console.error('Failed to connect to relay:', error)
      setConnected(false)
    }
  }

  const setupDVMSubscriptions = () => {
    if (!poolRef.current || !clientKeysRef.current) {
      console.log('setupDVMSubscriptions skipped: missing pool or keys')
      return
    }

    console.log('Setting up DVM subscriptions for both plain and encrypted DVMs')

    // Subscribe to heartbeats from BOTH DVMs (kind 11998)
    const heartbeatFilter: Filter = {
      kinds: [11998],
      authors: [plainDvmConfig.pubkeyHex, encryptedDvmConfig.pubkeyHex],
      since: Math.floor(Date.now() / 1000) - 60 // Last minute
    }

    try {
      // @ts-ignore - nostr-tools type signature issue
      poolRef.current.subscribe(
        [relayUrl],
        heartbeatFilter,
        {
          onevent: (event: NostrEvent) => {
            console.log('Received heartbeat from:', event.pubkey.slice(0, 8))

            // Check if heartbeat has encrypted tag
            const encryptedTag = event.tags.find(tag => tag[0] === 'encrypted' && tag[1] === 'nip17')
            const isEncrypted = !!encryptedTag

            const heartbeatInfo = {
              timestamp: event.created_at,
              status: event.content,
              encrypted: isEncrypted
            }

            if (event.pubkey === plainDvmConfig.pubkeyHex) {
              setPlainLastHeartbeat(heartbeatInfo)
            } else if (event.pubkey === encryptedDvmConfig.pubkeyHex) {
              setEncryptedLastHeartbeat(heartbeatInfo)
            }
          },
          oneose: () => {
            console.log('Heartbeat subscription EOSE received')
          }
        }
      )
      console.log('Heartbeat subscription created for both DVMs')
    } catch (e) {
      console.error('Error creating heartbeat subscription:', e)
    }

    // Subscribe to plain DVM responses (kind 25000)
    const plainResponseFilter: Filter = {
      kinds: [25000],
      authors: [plainDvmConfig.pubkeyHex],
      '#p': [clientKeysRef.current.publicKey],
      since: Math.floor(Date.now() / 1000)
    }

    try {
      // @ts-ignore - nostr-tools type signature issue
      poolRef.current.subscribe(
        [relayUrl],
        plainResponseFilter,
        {
          onevent: (event: NostrEvent) => {
            console.log('Received plain DVM response:', event)
            handlePlainDVMResponse(event)
          },
          oneose: () => {
            console.log('Plain response subscription EOSE received')
          }
        }
      )
      console.log('Plain response subscription created')
    } catch (e) {
      console.error('Error creating plain response subscription:', e)
    }

    // Subscribe to encrypted responses (gift wraps - kind 1059)
    const giftWrapFilter: Filter = {
      kinds: [1059],
      '#p': [clientKeysRef.current.publicKey],
      since: Math.floor(Date.now() / 1000) - (2 * 24 * 60 * 60) // 2 days for random timestamps
    }

    try {
      // @ts-ignore - nostr-tools type signature issue
      poolRef.current.subscribe(
        [relayUrl],
        giftWrapFilter,
        {
          onevent: async (event: NostrEvent) => {
            console.log('Received gift wrap, attempting to decrypt...')
            await handleEncryptedDVMResponse(event)
          },
          oneose: () => {
            console.log('Gift wrap subscription EOSE received')
          }
        }
      )
      console.log('Gift wrap subscription created')
    } catch (e) {
      console.error('Error creating gift wrap subscription:', e)
    }
  }

  // Re-setup subscriptions when connected
  useEffect(() => {
    if (connected) {
      setupDVMSubscriptions()
    }
  }, [connected])

  const handlePlainDVMResponse = (event: NostrEvent) => {
    console.log('handlePlainDVMResponse called')

    // Extract the request ID from e tag
    const eTag = event.tags.find(tag => tag[0] === 'e')
    if (!eTag || !eTag[1]) {
      console.log('No e-tag found in response')
      return
    }

    const requestId = eTag[1]
    const responseTime = Date.now()

    // Extract status
    const statusTag = event.tags.find(tag => tag[0] === 'status')
    const status = statusTag?.[1] || 'unknown'

    // Update manual request
    const currentRequest = plainLastRequestRef.current || plainLastRequest
    if (currentRequest && currentRequest.id === requestId) {
      const updatedRequest = {
        ...currentRequest,
        responseReceived: true,
        responseTime: responseTime - currentRequest.timestamp,
        responseContent: event.content,
        status
      }
      plainLastRequestRef.current = updatedRequest
      setPlainLastRequest(updatedRequest)
    }

    // Update performance test requests
    const refRequest = plainPerfRequestsRef.current.find(req => req.id === requestId)
    if (refRequest && !refRequest.responseReceived) {
      refRequest.responseReceived = true
      refRequest.responseTime = responseTime - refRequest.timestamp
      refRequest.responseContent = event.content
      refRequest.status = status
      plainPerfTimingRef.current.lastReceivedAt = responseTime
    }

    setPlainPerfRequests(prev => prev.map(req =>
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

  const handleEncryptedDVMResponse = async (giftWrapEvent: NostrEvent) => {
    if (!clientKeysRef.current) {
      console.error('Client keys not available')
      return
    }

    try {
      // Decrypt the gift wrap
      const decrypted = await decryptNip17GiftWrap(
        clientKeysRef.current.privateKeyHex,
        giftWrapEvent
      )

      if (!decrypted) {
        console.log('Failed to decrypt gift wrap')
        return
      }

      console.log('Successfully decrypted DVM response')
      console.log('From DVM:', decrypted.senderPubkey)
      console.log('Content:', decrypted.message.content)

      // Extract the request ID from e tag in the decrypted message
      const eTag = decrypted.message.tags?.find(tag => tag[0] === 'e')
      const requestId = eTag?.[1]
      const responseTime = Date.now()

      console.log('Response references request ID:', requestId)

      // Extract status
      const statusTag = decrypted.message.tags?.find(tag => tag[0] === 'status')
      const status = statusTag?.[1] || 'unknown'

      // Check if this is a performance test response
      const isPerfTestResponse = requestId && encryptedPerfRequestsRef.current.some(req => req.id === requestId)

      if (isPerfTestResponse) {
        // Update performance test request
        console.log('✅ Performance test response matched to request:', requestId.substring(0, 16) + '...')

        const refRequest = encryptedPerfRequestsRef.current.find(req => req.id === requestId)
        if (refRequest && !refRequest.responseReceived) {
          refRequest.responseReceived = true
          refRequest.responseTime = responseTime - refRequest.timestamp
          refRequest.responseContent = decrypted.message.content
          refRequest.status = status
          encryptedPerfTimingRef.current.lastReceivedAt = responseTime
        }

        setEncryptedPerfRequests(prev => prev.map(req =>
          req.id === requestId
            ? {
                ...req,
                responseReceived: true,
                responseTime: responseTime - req.timestamp,
                responseContent: decrypted.message.content,
                status
              }
            : req
        ))
      } else {
        // Check manual request
        console.log('Current tracked manual request ID:', encryptedLastRequestRef.current?.id || encryptedLastRequest?.id)

        const currentRequest = encryptedLastRequestRef.current || encryptedLastRequest
        if (currentRequest && requestId && currentRequest.id === requestId) {
          console.log('✅ Manual test response matched! Updating UI...')
          const updatedRequest = {
            ...currentRequest,
            responseReceived: true,
            responseTime: responseTime - currentRequest.timestamp,
            responseContent: decrypted.message.content,
            status,
            isEncrypted: true,
            matchedRequestId: requestId  // Store the matched ID for display
          }
          encryptedLastRequestRef.current = updatedRequest
          setEncryptedLastRequest(updatedRequest)
        } else if (requestId) {
          console.log('⚠️ Response with ID', requestId.substring(0, 16) + '...', 'not matched to any tracked request')
        } else {
          console.log('❌ Response missing request ID')
        }
      }

    } catch (error) {
      console.error('Error handling encrypted response:', error)
    }
  }

  const sendPlainJobRequest = async (input: string, isTargeted: boolean): Promise<string | null> => {
    if (!poolRef.current || !clientKeysRef.current) {
      console.error('Client not initialized')
      return null
    }

    const tags: string[][] = [
      ['i', input, 'text/plain'],
      ['category', 'echo'],
      ['t', 'echo']
    ]

    if (isTargeted) {
      tags.push(['p', plainDvmConfig.pubkeyHex])
    }

    const event = finalizeEvent({
      kind: 25000,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: `Job request: ${input}`
    }, clientKeysRef.current.secretKey)

    try {
      await poolRef.current.publish([relayUrl], event)
      console.log('Published plain job request:', event)
      return event.id
    } catch (error) {
      console.error('Failed to publish event:', error)
      return null
    }
  }

  const sendEncryptedJobRequest = async (input: string): Promise<string | null> => {
    if (!poolRef.current || !clientKeysRef.current) {
      console.error('Client not initialized')
      return null
    }

    try {
      // Create the job request tags
      const tags: string[][] = [
        ['i', input, 'text/plain'],
        ['category', 'echo']
      ]

      const content = `Encrypted job request: ${input}`

      // Encrypt using NIP-17
      const { giftWrap, unsignedEventId } = await encryptNip17Message(
        clientKeysRef.current.privateKeyHex,
        encryptedDvmConfig.pubkeyHex,
        content,
        tags,
        25000 // DVM job request kind
      )

      // Publish the gift wrap
      poolRef.current.publish([relayUrl], giftWrap)
      console.log('Published encrypted job request (gift wrap):', giftWrap)
      console.log('Unsigned event ID (for response matching):', unsignedEventId)

      // Return the unsigned event ID - this is what the DVM will reference in its response
      return unsignedEventId
    } catch (error) {
      console.error('Failed to send encrypted request:', error)
      return null
    }
  }

  // Manual test handlers
  const handlePlainManualTest = async () => {
    if (!plainTestInput.trim()) return

    setPlainManualLoading(true)
    await new Promise(resolve => setTimeout(resolve, 100))

    const eventId = await sendPlainJobRequest(plainTestInput, plainRequestType === 'targeted')

    if (eventId) {
      const requestObj = {
        id: eventId,
        input: plainTestInput,
        timestamp: Date.now(),
        responseReceived: false,
        isEncrypted: false
      }
      plainLastRequestRef.current = requestObj
      setPlainLastRequest(requestObj)
    }

    setPlainManualLoading(false)
  }

  const handleEncryptedManualTest = async () => {
    if (!encryptedTestInput.trim()) return

    setEncryptedManualLoading(true)
    await new Promise(resolve => setTimeout(resolve, 100))

    const eventId = await sendEncryptedJobRequest(encryptedTestInput)

    if (eventId) {
      const requestObj = {
        id: eventId,
        input: encryptedTestInput,
        timestamp: Date.now(),
        responseReceived: false,
        isEncrypted: true
      }
      encryptedLastRequestRef.current = requestObj
      setEncryptedLastRequest(requestObj)
    }

    setEncryptedManualLoading(false)
  }

  // Performance test handlers
  const handlePlainPerfTest = async () => {
    const count = getRequestCount(plainPerfRequestCount)
    setPlainPerfRunning(true)
    setPlainPerfProgress(0)
    setPlainPerfRequests([])
    plainPerfRequestsRef.current = []
    plainPerfTimingRef.current = { firstSentAt: 0, lastReceivedAt: 0 }
    setPlainPerfElapsedTime(0)

    const startTime = Date.now()
    const timerInterval = setInterval(() => {
      setPlainPerfElapsedTime((Date.now() - startTime) / 1000)
    }, 100)

    try {
      if (plainPerfMode === 'sequential') {
        // Sequential mode: wait for each response before sending next
        for (let i = 0; i < count; i++) {
          const input = `Test message ${i + 1}`
          const eventId = await sendPlainJobRequest(input, true)

          if (eventId) {
            const newRequest: JobRequest = {
              id: eventId,
              input,
              timestamp: Date.now(),
              responseReceived: false,
              isEncrypted: false,
              isPerfTest: true
            }

            if (i === 0) {
              plainPerfTimingRef.current.firstSentAt = newRequest.timestamp
            }

            plainPerfRequestsRef.current.push(newRequest)
            setPlainPerfRequests(prev => [...prev, newRequest])
            setPlainPerfProgress(i + 1)

            // Wait for response before sending next request
            await new Promise<void>((resolve) => {
              const checkResponse = setInterval(() => {
                const request = plainPerfRequestsRef.current.find(r => r.id === eventId)
                if (request?.responseReceived) {
                  clearInterval(checkResponse)
                  resolve()
                }
              }, 10)

              // Timeout after 30 seconds
              setTimeout(() => {
                clearInterval(checkResponse)
                resolve()
              }, 30000)
            })
          }
        }
      } else {
        // Parallel mode: send all requests as fast as possible
        for (let i = 0; i < count; i++) {
          const input = `Test message ${i + 1}`
          const eventId = await sendPlainJobRequest(input, true)

          if (eventId) {
            const newRequest: JobRequest = {
              id: eventId,
              input,
              timestamp: Date.now(),
              responseReceived: false,
              isEncrypted: false,
              isPerfTest: true
            }

            if (i === 0) {
              plainPerfTimingRef.current.firstSentAt = newRequest.timestamp
            }

            plainPerfRequestsRef.current.push(newRequest)
            setPlainPerfRequests(prev => [...prev, newRequest])
            setPlainPerfProgress(i + 1)
          }

          // 1ms delay to allow event loop to process responses
          await new Promise(resolve => setTimeout(resolve, 1))
        }
      }

    } finally {
      const stopTimer = () => {
        const elapsedTime = (Date.now() - startTime) / 1000
        setPlainPerfElapsedTime(elapsedTime)
        clearInterval(timerInterval)
        setPlainPerfRunning(false)

        // Calculate and freeze all metrics
        const completed = plainPerfRequestsRef.current.filter(r => r.responseReceived)
        const responseTimes = completed
          .map(r => r.responseTime)
          .filter((t): t is number => t !== undefined)
          .sort((a, b) => a - b)

        // Calculate median
        const median = responseTimes.length > 0
          ? responseTimes.length % 2 === 0
            ? (responseTimes[Math.floor(responseTimes.length / 2) - 1] + responseTimes[Math.floor(responseTimes.length / 2)]) / 2
            : responseTimes[Math.floor(responseTimes.length / 2)]
          : 0

        // Calculate average
        const avg = responseTimes.length > 0
          ? responseTimes.reduce((sum, t) => sum + t, 0) / responseTimes.length
          : 0

        // Calculate P95
        const p95 = responseTimes.length > 0
          ? responseTimes[Math.floor(responseTimes.length * 0.95)] || 0
          : 0

        // Calculate mode (for parallel only)
        let mode = 0
        if (plainPerfMode === 'parallel' && responseTimes.length > 0) {
          const roundedTimes = responseTimes.map(t => Math.round(t / 100) * 100)
          const frequency = new Map<number, number>()
          roundedTimes.forEach(time => {
            frequency.set(time, (frequency.get(time) || 0) + 1)
          })
          let maxCount = 0
          frequency.forEach((count, time) => {
            if (count > maxCount) {
              maxCount = count
              mode = time
            }
          })
        }

        // Freeze metrics
        setPlainPerfFinalMetrics({
          dvmType: 'plain',
          mode: plainPerfMode,
          requestCount: count,
          completedCount: completed.length,
          elapsedTime,
          throughput: plainPerfMode === 'parallel' ? completed.length / elapsedTime : undefined,
          medianRTT: median,
          avgRTT: avg,
          p95RTT: p95,
          modeRTT: plainPerfMode === 'parallel' ? mode : undefined,
          timestamp: new Date().toISOString()
        })
      }

      if (plainPerfMode === 'sequential') {
        // Sequential mode completes immediately after all responses
        stopTimer()
      } else {
        // Parallel mode: wait for all responses
        const checkComplete = setInterval(() => {
          const totalReceived = plainPerfRequestsRef.current.filter(r => r.responseReceived).length
          if (totalReceived === plainPerfRequestsRef.current.length) {
            clearInterval(checkComplete)
            stopTimer()
          }
        }, 100)

        setTimeout(() => {
          clearInterval(checkComplete)
          stopTimer()
        }, 60000)
      }
    }
  }

  const handleEncryptedPerfTest = async () => {
    const count = getRequestCount(encryptedPerfRequestCount)
    setEncryptedPerfRunning(true)
    setEncryptedPerfProgress(0)
    setEncryptedPerfRequests([])
    encryptedPerfRequestsRef.current = []
    encryptedPerfTimingRef.current = { firstSentAt: 0, lastReceivedAt: 0 }
    setEncryptedPerfElapsedTime(0)

    const startTime = Date.now()
    const timerInterval = setInterval(() => {
      setEncryptedPerfElapsedTime((Date.now() - startTime) / 1000)
    }, 100)

    try {
      if (encryptedPerfMode === 'sequential') {
        // Sequential mode: wait for each response before sending next
        for (let i = 0; i < count; i++) {
          const input = `Encrypted test ${i + 1}`
          const eventId = await sendEncryptedJobRequest(input)

          if (eventId) {
            const newRequest: JobRequest = {
              id: eventId,
              input,
              timestamp: Date.now(),
              responseReceived: false,
              isEncrypted: true,
              isPerfTest: true
            }

            if (i === 0) {
              encryptedPerfTimingRef.current.firstSentAt = newRequest.timestamp
            }

            encryptedPerfRequestsRef.current.push(newRequest)
            setEncryptedPerfRequests(prev => [...prev, newRequest])
            setEncryptedPerfProgress(i + 1)

            // Wait for response before sending next request
            await new Promise<void>((resolve) => {
              const checkResponse = setInterval(() => {
                const request = encryptedPerfRequestsRef.current.find(r => r.id === eventId)
                if (request?.responseReceived) {
                  clearInterval(checkResponse)
                  resolve()
                }
              }, 10)

              // Timeout after 30 seconds
              setTimeout(() => {
                clearInterval(checkResponse)
                resolve()
              }, 30000)
            })
          }
        }
      } else {
        // Parallel mode: send all requests with small delay
        for (let i = 0; i < count; i++) {
          const input = `Encrypted test ${i + 1}`
          const eventId = await sendEncryptedJobRequest(input)

          if (eventId) {
            const newRequest: JobRequest = {
              id: eventId,
              input,
              timestamp: Date.now(),
              responseReceived: false,
              isEncrypted: true,
              isPerfTest: true
            }

            if (i === 0) {
              encryptedPerfTimingRef.current.firstSentAt = newRequest.timestamp
            }

            encryptedPerfRequestsRef.current.push(newRequest)
            setEncryptedPerfRequests(prev => [...prev, newRequest])
            setEncryptedPerfProgress(i + 1)
          }

          // 1ms delay to allow event loop to process responses
          await new Promise(resolve => setTimeout(resolve, 1))
        }
      }

    } finally {
      const stopTimer = () => {
        const elapsedTime = (Date.now() - startTime) / 1000
        setEncryptedPerfElapsedTime(elapsedTime)
        clearInterval(timerInterval)
        setEncryptedPerfRunning(false)

        // Calculate and freeze all metrics
        const completed = encryptedPerfRequestsRef.current.filter(r => r.responseReceived)
        const responseTimes = completed
          .map(r => r.responseTime)
          .filter((t): t is number => t !== undefined)
          .sort((a, b) => a - b)

        // Calculate median
        const median = responseTimes.length > 0
          ? responseTimes.length % 2 === 0
            ? (responseTimes[Math.floor(responseTimes.length / 2) - 1] + responseTimes[Math.floor(responseTimes.length / 2)]) / 2
            : responseTimes[Math.floor(responseTimes.length / 2)]
          : 0

        // Calculate average
        const avg = responseTimes.length > 0
          ? responseTimes.reduce((sum, t) => sum + t, 0) / responseTimes.length
          : 0

        // Calculate P95
        const p95 = responseTimes.length > 0
          ? responseTimes[Math.floor(responseTimes.length * 0.95)] || 0
          : 0

        // Calculate mode (for parallel only)
        let mode = 0
        if (encryptedPerfMode === 'parallel' && responseTimes.length > 0) {
          const roundedTimes = responseTimes.map(t => Math.round(t / 100) * 100)
          const frequency = new Map<number, number>()
          roundedTimes.forEach(time => {
            frequency.set(time, (frequency.get(time) || 0) + 1)
          })
          let maxCount = 0
          frequency.forEach((count, time) => {
            if (count > maxCount) {
              maxCount = count
              mode = time
            }
          })
        }

        // Freeze metrics
        setEncryptedPerfFinalMetrics({
          dvmType: 'encrypted',
          mode: encryptedPerfMode,
          requestCount: count,
          completedCount: completed.length,
          elapsedTime,
          throughput: encryptedPerfMode === 'parallel' ? completed.length / elapsedTime : undefined,
          medianRTT: median,
          avgRTT: avg,
          p95RTT: p95,
          modeRTT: encryptedPerfMode === 'parallel' ? mode : undefined,
          timestamp: new Date().toISOString()
        })
      }

      if (encryptedPerfMode === 'sequential') {
        // Sequential mode completes immediately after all responses
        stopTimer()
      } else {
        // Parallel mode: wait for all responses
        const checkComplete = setInterval(() => {
          const totalReceived = encryptedPerfRequestsRef.current.filter(r => r.responseReceived).length
          if (totalReceived === encryptedPerfRequestsRef.current.length) {
            clearInterval(checkComplete)
            stopTimer()
          }
        }, 100)

        setTimeout(() => {
          clearInterval(checkComplete)
          stopTimer()
        }, 60000)
      }
    }
  }

  // Calculate performance metrics
  const plainCompletedRequests = plainPerfRequests.filter(r => r.responseReceived)
  const encryptedCompletedRequests = encryptedPerfRequests.filter(r => r.responseReceived)

  return (
    <main className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-100 p-8">
      <div className="max-w-full mx-auto px-4 space-y-6">

        <h1 className="text-3xl font-bold text-gray-800 mb-6">DVM Tester - Plain, Encrypted & Ecash</h1>

        {/* Three column layout for DVM cards */}
        <div className="grid lg:grid-cols-3 gap-6">

          {/* Plain DVM Column */}
          <div className="space-y-6">

            {/* Plain DVM Status */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                <span className="text-2xl">🔓</span> Plain DVM Status
              </h2>

              <div className="grid gap-4">
                <div>
                  <p className="text-sm text-gray-600">Connection</p>
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className="font-semibold">{connected ? 'Connected' : 'Disconnected'}</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">DVM Public Key (npub)</label>
                  <input
                    type="text"
                    value={plainDvmConfig.npub}
                    readOnly
                    className="w-full px-2 py-1 border border-gray-300 rounded font-mono text-xs bg-gray-50"
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">Last Heartbeat</label>
                  {plainLastHeartbeat ? (
                    <div>
                      <p className="font-mono text-lg">{new Date(plainLastHeartbeat.timestamp * 1000).toLocaleTimeString()}</p>
                      <p className="text-xs text-gray-500">Status: {plainLastHeartbeat.status}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">Waiting for heartbeat...</p>
                  )}
                </div>
              </div>
            </div>

            {/* Plain DVM Manual Test */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-xl font-bold text-gray-800 mb-4">🔓 Plain Manual Test</h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Request Type</label>
                  <div className="flex gap-4">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        value="targeted"
                        checked={plainRequestType === 'targeted'}
                        onChange={(e) => setPlainRequestType(e.target.value as 'open' | 'targeted')}
                        className="mr-2"
                      />
                      Targeted (p-tag)
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        value="open"
                        checked={plainRequestType === 'open'}
                        onChange={(e) => setPlainRequestType(e.target.value as 'open' | 'targeted')}
                        className="mr-2"
                      />
                      Open (hashtag)
                    </label>
                  </div>
                </div>

                <div>
                  <input
                    type="text"
                    value={plainTestInput}
                    onChange={(e) => setPlainTestInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !plainManualLoading) {
                        handlePlainManualTest()
                      }
                    }}
                    placeholder="Enter a message..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>

                <button
                  onClick={handlePlainManualTest}
                  disabled={plainManualLoading || !plainTestInput.trim() || !connected}
                  className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition"
                >
                  {plainManualLoading ? 'Sending...' : 'Send Plain Request'}
                </button>

                {plainLastRequest && (
                  <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                    <h4 className="font-semibold mb-2">Last Request</h4>
                    <div className="space-y-1 text-sm">
                      <p><span className="text-gray-600">Input:</span> {plainLastRequest.input}</p>
                      <p><span className="text-gray-600">Status:</span> {
                        plainLastRequest.responseReceived
                          ? <span className="text-green-600 font-semibold">✓ Response received</span>
                          : <span className="text-yellow-600">⏳ Waiting...</span>
                      }</p>
                      {plainLastRequest.responseReceived && (
                        <>
                          <p><span className="text-gray-600">Response:</span> {plainLastRequest.responseContent}</p>
                          <p><span className="text-gray-600">Time:</span> {plainLastRequest.responseTime}ms</p>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Plain DVM Performance Test */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-xl font-bold text-gray-800 mb-4">🔓 Plain Performance Test</h3>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Test Mode
                </label>
                <div className="flex gap-4 mb-4">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="sequential"
                      checked={plainPerfMode === 'sequential'}
                      onChange={(e) => setPlainPerfMode(e.target.value as 'sequential' | 'parallel')}
                      disabled={plainPerfRunning}
                      className="mr-2"
                    />
                    Sequential (User Experience)
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="parallel"
                      checked={plainPerfMode === 'parallel'}
                      onChange={(e) => setPlainPerfMode(e.target.value as 'sequential' | 'parallel')}
                      disabled={plainPerfRunning}
                      className="mr-2"
                    />
                    Parallel (System Capacity)
                  </label>
                </div>

                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Requests: <span className="text-purple-600 font-bold">{getRequestCount(plainPerfRequestCount).toLocaleString()}</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="4"
                  value={plainPerfRequestCount}
                  onChange={(e) => {
                    setPlainPerfRequestCount(parseInt(e.target.value))
                    setPlainPerfProgress(0)
                    setPlainPerfRequests([])
                  }}
                  disabled={plainPerfRunning}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>10</span>
                  <span>100</span>
                  <span>1K</span>
                  <span>10K</span>
                  <span>100K</span>
                </div>
              </div>

              <button
                onClick={handlePlainPerfTest}
                disabled={plainPerfRunning || !connected}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition mb-4"
              >
                {plainPerfRunning ? 'Running...' : `Send ${getRequestCount(plainPerfRequestCount).toLocaleString()} Requests`}
              </button>

              {plainPerfProgress > 0 && (
                <div className="space-y-3">
                  <div className="text-center text-sm text-gray-600">
                    Time: {plainPerfElapsedTime.toFixed(1)}s
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span>Sending</span>
                      <span>{plainPerfProgress}/{getRequestCount(plainPerfRequestCount)}</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all"
                        style={{ width: `${(plainPerfProgress / getRequestCount(plainPerfRequestCount)) * 100}%` }}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span>Receiving</span>
                      <span>{plainCompletedRequests.length}/{getRequestCount(plainPerfRequestCount)}</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-green-600 h-2 rounded-full transition-all"
                        style={{ width: `${(plainCompletedRequests.length / getRequestCount(plainPerfRequestCount)) * 100}%` }}
                      />
                    </div>
                  </div>

                  {plainPerfFinalMetrics && plainPerfFinalMetrics.mode === 'sequential' ? (
                    <div className="grid grid-cols-3 gap-2 text-sm bg-gray-50 p-3 rounded">
                      <div>
                        <p className="text-gray-600">Median RTT</p>
                        <p className="font-semibold">{plainPerfFinalMetrics.medianRTT.toFixed(0)} ms</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Avg RTT</p>
                        <p className="font-semibold">{plainPerfFinalMetrics.avgRTT.toFixed(0)} ms</p>
                      </div>
                      <div>
                        <p className="text-gray-600">P95 RTT</p>
                        <p className="font-semibold">{plainPerfFinalMetrics.p95RTT.toFixed(0)} ms</p>
                      </div>
                    </div>
                  ) : plainPerfFinalMetrics && plainPerfFinalMetrics.mode === 'parallel' ? (
                    <div className="grid grid-cols-4 gap-2 text-sm bg-gray-50 p-3 rounded">
                      <div>
                        <p className="text-gray-600">Throughput</p>
                        <p className="font-semibold">
                          {plainPerfFinalMetrics.throughput?.toFixed(1) || '0'} req/s
                        </p>
                      </div>
                      <div>
                        <p className="text-gray-600">Mode RTT</p>
                        <p className="font-semibold">{plainPerfFinalMetrics.modeRTT || 0} ms</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Avg RTT</p>
                        <p className="font-semibold">{plainPerfFinalMetrics.avgRTT.toFixed(0)} ms</p>
                      </div>
                      <div>
                        <p className="text-gray-600">P95 RTT</p>
                        <p className="font-semibold">{plainPerfFinalMetrics.p95RTT.toFixed(0)} ms</p>
                      </div>
                    </div>
                  ) : null}

                  {/* Export JSON button */}
                  {plainPerfFinalMetrics && (
                    <button
                      onClick={() => {
                        const dataStr = JSON.stringify(plainPerfFinalMetrics, null, 2)
                        const dataBlob = new Blob([dataStr], { type: 'application/json' })
                        const url = URL.createObjectURL(dataBlob)
                        const link = document.createElement('a')
                        link.href = url
                        link.download = `plain-dvm-perf-${plainPerfFinalMetrics.mode}-${Date.now()}.json`
                        link.click()
                        URL.revokeObjectURL(url)
                      }}
                      className="w-full text-sm px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded transition"
                    >
                      📋 Export Metrics JSON
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Encrypted DVM Column */}
          <div className="space-y-6">

            {/* Encrypted DVM Status */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                <span className="text-2xl">🔐</span> Encrypted DVM Status
              </h2>

              <div className="grid gap-4">
                <div>
                  <p className="text-sm text-gray-600">Connection</p>
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className="font-semibold">{connected ? 'Connected' : 'Disconnected'}</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">DVM Public Key (npub)</label>
                  <input
                    type="text"
                    value={encryptedDvmConfig.npub}
                    readOnly
                    className="w-full px-2 py-1 border border-gray-300 rounded font-mono text-xs bg-gray-50"
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">Last Heartbeat</label>
                  {encryptedLastHeartbeat ? (
                    <div>
                      <p className="font-mono text-lg">{new Date(encryptedLastHeartbeat.timestamp * 1000).toLocaleTimeString()}</p>
                      <p className="text-xs text-gray-500">Status: {encryptedLastHeartbeat.status}</p>
                      <p className="text-xs text-green-600">🔐 NIP-17 Encrypted</p>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">Waiting for heartbeat...</p>
                  )}
                </div>
              </div>
            </div>

            {/* Encrypted DVM Manual Test */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-xl font-bold text-gray-800 mb-4">🔐 Encrypted Manual Test</h3>

              <div className="space-y-4">
                <div className="bg-blue-50 p-3 rounded text-sm">
                  <p className="text-blue-800">All requests are encrypted using NIP-17 gift wrap</p>
                </div>

                <div>
                  <input
                    type="text"
                    value={encryptedTestInput}
                    onChange={(e) => setEncryptedTestInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !encryptedManualLoading) {
                        handleEncryptedManualTest()
                      }
                    }}
                    placeholder="Enter a secret message..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </div>

                <button
                  onClick={handleEncryptedManualTest}
                  disabled={encryptedManualLoading || !encryptedTestInput.trim() || !connected}
                  className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition"
                >
                  {encryptedManualLoading ? 'Encrypting & Sending...' : '🔐 Send Encrypted Request'}
                </button>

                {encryptedLastRequest && (
                  <div className="mt-4 p-4 bg-gray-50 rounded-lg">
                    <h4 className="font-semibold mb-2">Last Encrypted Request</h4>
                    <div className="space-y-1 text-sm">
                      <p><span className="text-gray-600">Input:</span> {encryptedLastRequest.input}</p>
                      <p><span className="text-gray-600">Encryption:</span> <span className="text-green-600">🔐 NIP-17</span></p>
                      <p><span className="text-gray-600">Request ID:</span> <span className="font-mono text-xs">{encryptedLastRequest.id.substring(0, 16)}...</span></p>
                      <p><span className="text-gray-600">Status:</span> {
                        encryptedLastRequest.responseReceived
                          ? <span className="text-green-600 font-semibold">✓ Response decrypted</span>
                          : <span className="text-yellow-600">⏳ Waiting...</span>
                      }</p>
                      {encryptedLastRequest.responseReceived && (
                        <>
                          <p><span className="text-gray-600">ID Match:</span> {
                            encryptedLastRequest.matchedRequestId === encryptedLastRequest.id
                              ? <span className="text-green-600 font-semibold">✅ Verified - Response matched to request {encryptedLastRequest.id.substring(0, 16)}...</span>
                              : <span className="text-red-600">❌ Mismatch</span>
                          }</p>
                          <p><span className="text-gray-600">Response:</span> {encryptedLastRequest.responseContent}</p>
                          <p><span className="text-gray-600">Time:</span> {encryptedLastRequest.responseTime}ms</p>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Encrypted DVM Performance Test */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-xl font-bold text-gray-800 mb-4">🔐 Encrypted Performance Test</h3>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Test Mode
                </label>
                <div className="flex gap-4 mb-4">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="sequential"
                      checked={encryptedPerfMode === 'sequential'}
                      onChange={(e) => setEncryptedPerfMode(e.target.value as 'sequential' | 'parallel')}
                      disabled={encryptedPerfRunning}
                      className="mr-2"
                    />
                    Sequential (User Experience)
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="parallel"
                      checked={encryptedPerfMode === 'parallel'}
                      onChange={(e) => setEncryptedPerfMode(e.target.value as 'sequential' | 'parallel')}
                      disabled={encryptedPerfRunning}
                      className="mr-2"
                    />
                    Parallel (System Capacity)
                  </label>
                </div>

                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Requests: <span className="text-green-600 font-bold">{getRequestCount(encryptedPerfRequestCount).toLocaleString()}</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="3"
                  value={encryptedPerfRequestCount}
                  onChange={(e) => {
                    setEncryptedPerfRequestCount(parseInt(e.target.value))
                    setEncryptedPerfProgress(0)
                    setEncryptedPerfRequests([])
                  }}
                  disabled={encryptedPerfRunning}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>10</span>
                  <span>100</span>
                  <span>1K</span>
                  <span>10K</span>
                </div>
              </div>

              <button
                onClick={handleEncryptedPerfTest}
                disabled={encryptedPerfRunning || !connected}
                className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition mb-4"
              >
                {encryptedPerfRunning ? 'Encrypting & Running...' : `🔐 Send ${getRequestCount(encryptedPerfRequestCount).toLocaleString()} Encrypted`}
              </button>

              {encryptedPerfProgress > 0 && (
                <div className="space-y-3">
                  <div className="text-center text-sm text-gray-600">
                    Time: {encryptedPerfElapsedTime.toFixed(1)}s
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span>Encrypting & Sending</span>
                      <span>{encryptedPerfProgress}/{getRequestCount(encryptedPerfRequestCount)}</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-green-600 h-2 rounded-full transition-all"
                        style={{ width: `${(encryptedPerfProgress / getRequestCount(encryptedPerfRequestCount)) * 100}%` }}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span>Decrypting & Receiving</span>
                      <span>{encryptedCompletedRequests.length}/{getRequestCount(encryptedPerfRequestCount)}</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all"
                        style={{ width: `${(encryptedCompletedRequests.length / getRequestCount(encryptedPerfRequestCount)) * 100}%` }}
                      />
                    </div>
                  </div>

                  {encryptedPerfFinalMetrics && encryptedPerfFinalMetrics.mode === 'sequential' ? (
                    <div className="grid grid-cols-3 gap-2 text-sm bg-gray-50 p-3 rounded">
                      <div>
                        <p className="text-gray-600">Median RTT</p>
                        <p className="font-semibold">{encryptedPerfFinalMetrics.medianRTT.toFixed(0)} ms</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Avg RTT</p>
                        <p className="font-semibold">{encryptedPerfFinalMetrics.avgRTT.toFixed(0)} ms</p>
                      </div>
                      <div>
                        <p className="text-gray-600">P95 RTT</p>
                        <p className="font-semibold">{encryptedPerfFinalMetrics.p95RTT.toFixed(0)} ms</p>
                      </div>
                    </div>
                  ) : encryptedPerfFinalMetrics && encryptedPerfFinalMetrics.mode === 'parallel' ? (
                    <div className="grid grid-cols-4 gap-2 text-sm bg-gray-50 p-3 rounded">
                      <div>
                        <p className="text-gray-600">Throughput</p>
                        <p className="font-semibold">
                          {encryptedPerfFinalMetrics.throughput?.toFixed(1) || '0'} req/s
                        </p>
                      </div>
                      <div>
                        <p className="text-gray-600">Mode RTT</p>
                        <p className="font-semibold">{encryptedPerfFinalMetrics.modeRTT || 0} ms</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Avg RTT</p>
                        <p className="font-semibold">{encryptedPerfFinalMetrics.avgRTT.toFixed(0)} ms</p>
                      </div>
                      <div>
                        <p className="text-gray-600">P95 RTT</p>
                        <p className="font-semibold">{encryptedPerfFinalMetrics.p95RTT.toFixed(0)} ms</p>
                      </div>
                    </div>
                  ) : null}

                  {/* Export JSON button */}
                  {encryptedPerfFinalMetrics && (
                    <button
                      onClick={() => {
                        const dataStr = JSON.stringify(encryptedPerfFinalMetrics, null, 2)
                        const dataBlob = new Blob([dataStr], { type: 'application/json' })
                        const url = URL.createObjectURL(dataBlob)
                        const link = document.createElement('a')
                        link.href = url
                        link.download = `encrypted-dvm-perf-${encryptedPerfFinalMetrics.mode}-${Date.now()}.json`
                        link.click()
                        URL.revokeObjectURL(url)
                      }}
                      className="w-full text-sm px-3 py-2 bg-green-500 hover:bg-green-600 text-white rounded transition"
                    >
                      📋 Export Metrics JSON
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Encrypted Ecash DVM Column */}
          <DVMEcashColumn
            pool={poolRef.current}
            connected={connected}
            clientKeys={clientKeysRef.current}
            relayUrl={ecashRelayUrl}
          />

        </div>

      </div>
    </main>
  )
}