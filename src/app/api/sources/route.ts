import { NextRequest, NextResponse } from 'next/server';
import { getOrderedSources, type SourceConfig } from '@/lib/sources';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const type = searchParams.get('type') || 'movie'; // movie or tv

  const sources = getOrderedSources().map((s: SourceConfig) => ({
    id: s.id,
    name: s.name,
    apiOrigin: s.apiOrigin,
    languageFlags: s.languageFlags,
    languages: s.languages,
    order: s.order,
    reliability: s.reliability,
    note: s.note,
  }));

  return NextResponse.json({
    type,
    sources,
  });
}
