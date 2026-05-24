import { NextRequest, NextResponse } from 'next/server'

const TMDB_API_KEY = process.env.TMDB_API_KEY || '7967738a03ec215c7d6d675faba9c973'
const BASE_URL = 'https://api.themoviedb.org/3'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const path = searchParams.get('path')

  if (!path) {
    return NextResponse.json({ error: 'path parameter is required' }, { status: 400 })
  }

  const params: Record<string, string> = { api_key: TMDB_API_KEY }
  searchParams.forEach((value, key) => {
    if (key !== 'path' && key !== 'api_key') {
      params[key] = value
    }
  })

  try {
    const qs = new URLSearchParams(params).toString()
    const url = `${BASE_URL}${path.startsWith('/') ? path : '/' + path}?${qs}`

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      next: { revalidate: 600 },
    })

    if (!response.ok) {
      return NextResponse.json({ error: `TMDB API error: ${response.status}` }, { status: response.status })
    }

    const data = await response.json()
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=3600',
      },
    })
  } catch (error) {
    console.error('[TMDB Proxy] Error:', error)
    return NextResponse.json({ error: 'Failed to fetch from TMDB' }, { status: 502 })
  }
}
