'use client'

import { useState } from 'react'
import { CashuMint, CashuWallet, getEncodedTokenV4, MintQuoteState } from '@cashu/cashu-ts'

export default function Home() {
  const [mintedToken, setMintedToken] = useState('')
  const [spendToken, setSpendToken] = useState('')
  const [mintLoading, setMintLoading] = useState(false)
  const [spendLoading, setSpendLoading] = useState(false)
  const [mintError, setMintError] = useState('')
  const [spendResult, setSpendResult] = useState('')

  // Performance testing state
  const [perfMintProgress, setPerfMintProgress] = useState(0)
  const [perfMintTime, setPerfMintTime] = useState(0)
  const [perfSpendProgress, setPerfSpendProgress] = useState(0)
  const [perfSpendTime, setPerfSpendTime] = useState(0)
  const [perfMintedTokens, setPerfMintedTokens] = useState<string[]>([])
  const [perfRunning, setPerfRunning] = useState(false)
  const [perfStatus, setPerfStatus] = useState('')
  const [tokenCount, setTokenCount] = useState(2) // 0=10, 1=100, 2=1000, 3=10000, 4=100000, 5=1000000

  // Sidebar state
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false)

  const MINT_URL = process.env.NEXT_PUBLIC_MINT_URL || 'http://localhost:8096'

  // Helper to get actual token count from slider value
  const getTokenCount = () => Math.pow(10, tokenCount + 1)

  const handleMint = async () => {
    setMintLoading(true)
    setMintError('')
    setMintedToken('')

    try {
      // Initialize mint and wallet
      const mint = new CashuMint(MINT_URL)
      const wallet = new CashuWallet(mint)

      // Get keys from the mint
      await wallet.loadMint()

      // Request a mint quote for 1 sat
      const mintQuote = await wallet.createMintQuote(1)

      console.log('Mint quote:', mintQuote)

      // Wait for the quote to be paid (fakewallet has no delay in demo mode)
      // Poll for up to 3 seconds with 100ms intervals
      let mintQuoteChecked
      let attempts = 0
      const maxAttempts = 30

      while (attempts < maxAttempts) {
        mintQuoteChecked = await wallet.checkMintQuote(mintQuote.quote)

        if (mintQuoteChecked.state === MintQuoteState.PAID) {
          break
        }

        // Wait 100ms before checking again
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }

      if (mintQuoteChecked?.state !== MintQuoteState.PAID) {
        throw new Error('Quote not paid after waiting')
      }

      // Mint tokens - request 1 sat worth of tokens
      const proofs = await wallet.mintProofs(1, mintQuote.quote)

      // Encode the token for sharing
      const token = getEncodedTokenV4({
        mint: MINT_URL,
        proofs: proofs
      })

      setMintedToken(token)
    } catch (error) {
      console.error('Mint error:', error)
      setMintError(error instanceof Error ? error.message : 'Failed to mint token')
    } finally {
      setMintLoading(false)
    }
  }

  const handleSpend = async () => {
    setSpendLoading(true)
    setSpendResult('')

    try {
      if (!spendToken.trim()) {
        throw new Error('Please paste a token to spend')
      }

      // Initialize mint and wallet
      const mint = new CashuMint(MINT_URL)
      const wallet = new CashuWallet(mint)
      await wallet.loadMint()

      // Receive the token (this validates it with the mint)
      const received = await wallet.receive(spendToken)

      const totalAmount = received.reduce((acc, p) => acc + p.amount, 0)
      setSpendResult(`Successfully spent token! Received ${totalAmount} sats`)
    } catch (error) {
      console.error('Spend error:', error)
      setSpendResult(`Error: ${error instanceof Error ? error.message : 'Failed to spend token'}`)
    } finally {
      setSpendLoading(false)
    }
  }

  const copyToClipboard = () => {
    navigator.clipboard.writeText(mintedToken)
  }

  const handlePerfMint = async () => {
    const numTokens = getTokenCount()
    setPerfRunning(true)
    setPerfMintProgress(0)
    setPerfMintTime(0)
    setPerfMintedTokens([])
    setPerfStatus(`Minting ${numTokens.toLocaleString()} tokens...`)

    const startTime = Date.now()
    const tokens: string[] = []

    // Start timer
    const timerInterval = setInterval(() => {
      setPerfMintTime((Date.now() - startTime) / 1000)
    }, 100)

    try {
      // Initialize mint and wallet once
      const mint = new CashuMint(MINT_URL)
      const wallet = new CashuWallet(mint)
      await wallet.loadMint()

      for (let i = 0; i < numTokens; i++) {
        try {
          // Request a mint quote for 1 sat
          const mintQuote = await wallet.createMintQuote(1)

          // Wait for the quote to be paid
          let mintQuoteChecked
          let attempts = 0
          const maxAttempts = 30

          while (attempts < maxAttempts) {
            mintQuoteChecked = await wallet.checkMintQuote(mintQuote.quote)

            if (mintQuoteChecked.state === MintQuoteState.PAID) {
              break
            }

            await new Promise(resolve => setTimeout(resolve, 100))
            attempts++
          }

          if (mintQuoteChecked?.state !== MintQuoteState.PAID) {
            throw new Error('Quote not paid after waiting')
          }

          // Mint tokens
          const proofs = await wallet.mintProofs(1, mintQuote.quote)

          // Encode the token
          const token = getEncodedTokenV4({
            mint: MINT_URL,
            proofs: proofs
          })

          tokens.push(token)
          setPerfMintProgress(i + 1)
        } catch (error) {
          console.error(`Error minting token ${i + 1}:`, error)
          throw error
        }
      }

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2)
      setPerfMintedTokens(tokens)
      setPerfStatus(`Successfully minted ${numTokens.toLocaleString()} tokens in ${totalTime}s`)
    } catch (error) {
      console.error('Performance mint error:', error)
      setPerfStatus(`Error: ${error instanceof Error ? error.message : 'Failed to mint tokens'}`)
    } finally {
      clearInterval(timerInterval)
      setPerfRunning(false)
    }
  }

  const handlePerfSpend = async () => {
    if (perfMintedTokens.length === 0) {
      setPerfStatus('Error: No tokens to spend. Please mint tokens first.')
      return
    }

    setPerfRunning(true)
    setPerfSpendProgress(0)
    setPerfSpendTime(0)
    setPerfStatus('Spending tokens...')

    const startTime = Date.now()

    // Start timer
    const timerInterval = setInterval(() => {
      setPerfSpendTime((Date.now() - startTime) / 1000)
    }, 100)

    try {
      // Initialize mint and wallet once
      const mint = new CashuMint(MINT_URL)
      const wallet = new CashuWallet(mint)
      await wallet.loadMint()

      for (let i = 0; i < perfMintedTokens.length; i++) {
        try {
          // Receive (spend) the token
          await wallet.receive(perfMintedTokens[i])
          setPerfSpendProgress(i + 1)
        } catch (error) {
          console.error(`Error spending token ${i + 1}:`, error)
          throw error
        }
      }

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2)
      setPerfStatus(`Successfully spent ${perfMintedTokens.length.toLocaleString()} tokens in ${totalTime}s`)
    } catch (error) {
      console.error('Performance spend error:', error)
      setPerfStatus(`Error: ${error instanceof Error ? error.message : 'Failed to spend tokens'}`)
    } finally {
      clearInterval(timerInterval)
      setPerfRunning(false)
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="flex">
        {/* Left Sidebar - Instructions Panel */}
        <aside
          className={`${
            isPanelCollapsed ? 'w-12' : 'w-80'
          } transition-all duration-300 ease-in-out bg-white shadow-lg flex-shrink-0`}
        >
          {isPanelCollapsed ? (
            // Collapsed state - vertical tab
            <div className="h-full flex items-center justify-center">
              <button
                onClick={() => setIsPanelCollapsed(false)}
                className="writing-mode-vertical text-gray-600 hover:text-gray-900 font-medium py-8 transform rotate-180"
                style={{ writingMode: 'vertical-rl' }}
              >
                Instructions →
              </button>
            </div>
          ) : (
            // Expanded state - full instructions
            <div className="p-6 h-screen overflow-y-auto">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold text-gray-800">
                  How to use:
                </h3>
                <button
                  onClick={() => setIsPanelCollapsed(true)}
                  className="text-gray-500 hover:text-gray-700 text-xl"
                  title="Collapse panel"
                >
                  ←
                </button>
              </div>
              <ol className="list-decimal list-inside space-y-2 text-gray-600 mb-6">
                <li>Click "Mint 1 Sat Token" to create a new ecash token</li>
                <li>Copy the minted token using the "Copy" button</li>
                <li>Paste the token in the "Spend Token" section</li>
                <li>Click "Spend Token" to verify and redeem it with the mint</li>
              </ol>
              <div className="border-t border-gray-200 pt-4">
                <p className="text-sm text-gray-500">
                  Mint URL:
                </p>
                <code className="block bg-gray-100 px-2 py-1 rounded mt-2 text-xs break-all">
                  {MINT_URL}
                </code>
              </div>
            </div>
          )}
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 p-8">
          <div className="max-w-4xl mx-auto">

        <div className="grid md:grid-cols-2 gap-6">
          {/* Mint Section */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">
              Mint Token
            </h2>
            <p className="text-gray-600 mb-4">
              Create a new 1 sat ecash token
            </p>

            <button
              onClick={handleMint}
              disabled={mintLoading}
              className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-semibold py-3 px-4 rounded-lg transition duration-200 mb-4"
            >
              {mintLoading ? 'Minting...' : 'Mint 1 Sat Token'}
            </button>

            {mintError && (
              <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
                {mintError}
              </div>
            )}

            {mintedToken && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">
                  Minted Token:
                </label>
                <div className="relative">
                  <textarea
                    value={mintedToken}
                    readOnly
                    className="w-full h-32 p-3 border border-gray-300 rounded-lg font-mono text-xs bg-gray-50"
                  />
                  <button
                    onClick={copyToClipboard}
                    className="absolute top-2 right-2 bg-blue-600 hover:bg-blue-700 text-white text-xs py-1 px-3 rounded"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Spend Section */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">
              Spend Token
            </h2>
            <p className="text-gray-600 mb-4">
              Paste and verify an ecash token
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Token to Spend:
                </label>
                <textarea
                  value={spendToken}
                  onChange={(e) => setSpendToken(e.target.value)}
                  placeholder="Paste ecash token here..."
                  className="w-full h-32 p-3 border border-gray-300 rounded-lg font-mono text-xs"
                />
              </div>

              <button
                onClick={handleSpend}
                disabled={spendLoading || !spendToken.trim()}
                className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-3 px-4 rounded-lg transition duration-200"
              >
                {spendLoading ? 'Spending...' : 'Spend Token'}
              </button>

              {spendResult && (
                <div className={`px-4 py-3 rounded ${
                  spendResult.includes('Error')
                    ? 'bg-red-100 border border-red-400 text-red-700'
                    : 'bg-green-100 border border-green-400 text-green-700'
                }`}>
                  {spendResult}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Performance Testing Section */}
        <div className="mt-6 bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-2xl font-semibold text-gray-800 mb-4">
            Performance Testing
          </h2>
          <p className="text-gray-600 mb-4">
            Test the performance of minting and spending large batches of tokens
          </p>

          {/* Token Count Slider */}
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Number of tokens: <span className="text-blue-600 font-bold text-lg">{getTokenCount().toLocaleString()}</span>
            </label>
            <input
              type="range"
              min="0"
              max="5"
              value={tokenCount}
              onChange={(e) => {
                setTokenCount(parseInt(e.target.value))
                // Clear visual state when slider changes
                setPerfMintProgress(0)
                setPerfSpendProgress(0)
                setPerfMintTime(0)
                setPerfSpendTime(0)
                setPerfStatus('')
              }}
              disabled={perfRunning}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer disabled:opacity-50"
              style={{
                background: perfRunning ? undefined : `linear-gradient(to right, #2563eb 0%, #2563eb ${(tokenCount / 5) * 100}%, #e5e7eb ${(tokenCount / 5) * 100}%, #e5e7eb 100%)`
              }}
            />
            <div className="flex justify-between text-xs text-gray-500 mt-2">
              <span>10</span>
              <span>100</span>
              <span>1K</span>
              <span>10K</span>
              <span>100K</span>
              <span>1M</span>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4 mb-6">
            {/* Mint Performance */}
            <div className="space-y-3">
              <button
                onClick={handlePerfMint}
                disabled={perfRunning}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-3 px-4 rounded-lg transition duration-200"
              >
                Mint {getTokenCount().toLocaleString()} Tokens
              </button>

              {perfMintProgress > 0 && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-gray-600">
                    <span>Progress: {perfMintProgress.toLocaleString()}/{getTokenCount().toLocaleString()}</span>
                    <span>Time: {perfMintTime.toFixed(1)}s{perfMintProgress > 0 && ` (avg ${((perfMintTime * 1000) / perfMintProgress).toFixed(0)} ms)`}</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-4">
                    <div
                      className="bg-blue-600 h-4 rounded-full transition-all duration-200"
                      style={{ width: `${(perfMintProgress / getTokenCount()) * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Spend Performance */}
            <div className="space-y-3">
              <button
                onClick={handlePerfSpend}
                disabled={perfRunning || perfMintedTokens.length === 0}
                className="w-full bg-orange-600 hover:bg-orange-700 disabled:bg-gray-400 text-white font-semibold py-3 px-4 rounded-lg transition duration-200"
              >
                Spend All Tokens
              </button>

              {perfSpendProgress > 0 && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-gray-600">
                    <span>Progress: {perfSpendProgress.toLocaleString()}/{perfMintedTokens.length.toLocaleString()}</span>
                    <span>Time: {perfSpendTime.toFixed(1)}s{perfSpendProgress > 0 && ` (avg ${((perfSpendTime * 1000) / perfSpendProgress).toFixed(0)} ms)`}</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-4">
                    <div
                      className="bg-orange-600 h-4 rounded-full transition-all duration-200"
                      style={{ width: `${(perfSpendProgress / perfMintedTokens.length) * 100}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {perfStatus && (
            <div className={`px-4 py-3 rounded ${
              perfStatus.includes('Error')
                ? 'bg-red-100 border border-red-400 text-red-700'
                : perfStatus.includes('Successfully')
                ? 'bg-green-100 border border-green-400 text-green-700'
                : 'bg-blue-100 border border-blue-400 text-blue-700'
            }`}>
              {perfStatus}
            </div>
          )}
        </div>
          </div>
        </div>
      </div>
    </main>
  )
}
