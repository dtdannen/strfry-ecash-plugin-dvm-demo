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

  const MINT_URL = process.env.NEXT_PUBLIC_MINT_URL || 'http://localhost:8085'

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

      // Wait for the quote to be paid (fakewallet has a 1-3 second delay)
      // Poll for up to 10 seconds
      let mintQuoteChecked
      let attempts = 0
      const maxAttempts = 10

      while (attempts < maxAttempts) {
        mintQuoteChecked = await wallet.checkMintQuote(mintQuote.quote)

        if (mintQuoteChecked.state === MintQuoteState.PAID) {
          break
        }

        // Wait 1 second before checking again
        await new Promise(resolve => setTimeout(resolve, 1000))
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

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-800 mb-2 text-center">
          Ecash Mint Tester
        </h1>
        <p className="text-gray-600 mb-8 text-center">
          Test minting and spending Cashu ecash tokens
        </p>

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

        <div className="mt-8 bg-white rounded-lg shadow-lg p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-2">
            How to use:
          </h3>
          <ol className="list-decimal list-inside space-y-2 text-gray-600">
            <li>Click "Mint 1 Sat Token" to create a new ecash token</li>
            <li>Copy the minted token using the "Copy" button</li>
            <li>Paste the token in the "Spend Token" section</li>
            <li>Click "Spend Token" to verify and redeem it with the mint</li>
          </ol>
          <p className="mt-4 text-sm text-gray-500">
            Mint URL: <code className="bg-gray-100 px-2 py-1 rounded">{MINT_URL}</code>
          </p>
        </div>
      </div>
    </main>
  )
}
