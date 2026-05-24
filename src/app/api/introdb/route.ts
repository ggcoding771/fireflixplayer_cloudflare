import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge';

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const imdbId = searchParams.get('imdb_id')
  const season = searchParams.get('season')
  const episode = searchParams.get('episode')

  if (!imdbId) {
    return NextResponse.json(
      { error: 'imdb_id parameter is required' },
      { status: 400 }
    )
  }

  try {
    let url = `https://api.introdb.app/segments?imdb_id=${encodeURIComponent(imdbId)}`
    if (season) url += `&season=${season}`
    if (episode) url += `&episode=${episode}`

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'FireFlix/1.0',
      },
      next: { revalidate: 300 },
    })

    if (!response.ok) {
      return NextResponse.json({
        imdb_id: imdbId,
        season: season ? parseInt(season) : null,
        episode: episode ? parseInt(episode) : null,
        intro: null,
        recap: null,
        outro: null,
      })
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('IntroDB API error:', error)
    return NextResponse.json({
      imdb_id: imdbId,
      season: season ? parseInt(season) : null,
      episode: episode ? parseInt(episode) : null,
      intro: null,
      recap: null,
      outro: null,
    })
  }
}
