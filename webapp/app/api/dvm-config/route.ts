import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'

// Force dynamic rendering - don't cache this route
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const envPath = '/dvm-data/.env'

    // Debug logging
    console.log('Checking for DVM config at:', envPath)
    console.log('File exists:', existsSync(envPath))

    // Check if file exists
    if (!existsSync(envPath)) {
      console.error('DVM config file not found')
      return NextResponse.json(
        { error: 'DVM configuration not found. Make sure the DVM container is running.' },
        { status: 404 }
      )
    }

    // Read the .env file
    const envContent = await readFile(envPath, 'utf-8')

    // Parse the npub and pubkey hex
    let npub = ''
    let pubkeyHex = ''

    const lines = envContent.split('\n')
    for (const line of lines) {
      if (line.startsWith('DVM_NPUB=')) {
        npub = line.split('=')[1].trim()
      } else if (line.startsWith('DVM_PUBKEY_HEX=')) {
        pubkeyHex = line.split('=')[1].trim()
      }
    }

    if (!npub || !pubkeyHex) {
      return NextResponse.json(
        { error: 'Invalid DVM configuration format' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      npub,
      pubkeyHex,
      relayUrl: 'ws://localhost:7788'
    })
  } catch (error) {
    console.error('Error reading DVM config:', error)
    return NextResponse.json(
      { error: 'Failed to read DVM configuration' },
      { status: 500 }
    )
  }
}
