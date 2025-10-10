'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function Navigation() {
  const pathname = usePathname()

  return (
    <nav className="bg-white shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Project Title */}
          <div className="flex-shrink-0">
            <h1 className="text-xl font-bold text-gray-800">
              Strfry Ecash DVM Performance Tests
            </h1>
          </div>

          {/* Navigation Links */}
          <div className="flex space-x-4">
            <Link
              href="/"
              className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                pathname === '/'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              Ecash Mint Tester
            </Link>
            <Link
              href="/dvm-tester"
              className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                pathname === '/dvm-tester'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              User↔Relay↔DVM Tester
            </Link>
          </div>
        </div>
      </div>
    </nav>
  )
}
