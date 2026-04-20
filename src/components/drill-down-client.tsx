'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ThemeToggle } from '@/components/theme-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchMissingForLocale } from '@/lib/hygraph'
import type { MissingEntry } from '@/types'
import {
  ArrowLeft,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  modelApiId: string
  locale: string
  modelDisplayName: string
}

export function DrillDownClient({ modelApiId, locale, modelDisplayName }: Props) {
  const router = useRouter()
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [entries, setEntries] = useState<MissingEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const ep = sessionStorage.getItem('hg_endpoint')
    const tk = sessionStorage.getItem('hg_token')
    if (!ep || !tk) {
      router.replace('/')
      return
    }
    setEndpoint(ep)
    setToken(tk)
  }, [router])

  const loadMissing = useCallback(async () => {
    if (!endpoint || !token) return
    setLoading(true)
    setError(null)
    setProgress(0)
    setEntries([])

    try {
      // Derive the singular PascalCase type name from the plural camelCase apiId
      // e.g. "blogPosts" -> "BlogPost", "categories" -> "Category"
      const singular = modelApiId.replace(/ies$/, 'y').replace(/s$/, '')
      const modelType = singular.charAt(0).toUpperCase() + singular.slice(1)

      const defaultLocale = sessionStorage.getItem('hg_default_locale') ?? 'en'

      const missing = await fetchMissingForLocale(
        { endpoint, token },
        modelApiId,
        modelType,
        locale,
        defaultLocale,
        (fetched) => setProgress(fetched),
      )
      setEntries(missing)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load missing entries')
    } finally {
      setLoading(false)
    }
  }, [endpoint, token, modelApiId, locale])

  useEffect(() => {
    if (endpoint && token) loadMissing()
  }, [endpoint, token, loadMissing])

  const filtered = entries.filter(
    (e) =>
      e.title.toLowerCase().includes(search.toLowerCase()) ||
      e.id.toLowerCase().includes(search.toLowerCase()),
  )

  function exportCSV() {
    const rows = [
      ['Entry ID', 'Title', 'Missing Locale', 'Studio URL'],
      ...entries.map((e) => [e.id, e.title, locale, e.studioUrl]),
    ]
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `missing-${locale}-${modelApiId}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border/60 bg-background/95 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
              <Globe className="w-4 h-4 text-primary-foreground" />
            </div>
          </Link>
          <div className="text-muted-foreground">/</div>
          <Link
            href="/dashboard"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden sm:block"
          >
            Dashboard
          </Link>
          <div className="text-muted-foreground hidden sm:block">/</div>
          <span className="text-sm font-medium truncate">{modelDisplayName}</span>
          <Badge variant="secondary" className="shrink-0 text-xs">
            {locale.replace('_', '-')}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        {/* Back + title */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-2"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to dashboard
            </Link>
            <h1 className="text-xl font-bold tracking-tight">
              Missing <span className="text-primary">{locale.replace('_', '-')}</span> translations
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {modelDisplayName} entries that have no {locale.replace('_', '-')} localisation
            </p>
          </div>

          {!loading && entries.length > 0 && (
            <Button variant="outline" size="sm" onClick={exportCSV} className="shrink-0 gap-2">
              Export CSV
            </Button>
          )}
        </div>

        {error ? (
          <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
            <XCircle className="w-10 h-10 text-destructive" />
            <div>
              <p className="font-semibold">Failed to load entries</p>
              <p className="text-sm text-muted-foreground mt-1">{error}</p>
            </div>
            <Button onClick={loadMissing} variant="outline" className="gap-2">
              <RefreshCw className="w-4 h-4" /> Try again
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Scanning entries… {progress > 0 && `(${progress} checked so far)`}
            </div>
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-4 py-3 rounded-xl border border-border"
              >
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-8 w-24 rounded-lg" />
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center">
              <Globe className="w-6 h-6 text-emerald-600" />
            </div>
            <p className="font-semibold text-lg">All entries are translated!</p>
            <p className="text-sm text-muted-foreground">
              Every {modelDisplayName} entry has a {locale.replace('_', '-')} localisation.
            </p>
            <Link href="/dashboard">
              <Button variant="outline" className="gap-2 mt-2">
                <ArrowLeft className="w-4 h-4" /> Back to dashboard
              </Button>
            </Link>
          </div>
        ) : (
          <>
            {/* Stats + search */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
              <div className="flex items-center gap-2">
                <Badge
                  variant="secondary"
                  className="bg-destructive/10 text-destructive font-semibold"
                >
                  {entries.length} missing
                </Badge>
                <span className="text-sm text-muted-foreground">
                  entries need a {locale.replace('_', '-')} translation
                </span>
              </div>
              <div className="relative sm:ml-auto sm:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search entries…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 h-8 text-sm"
                />
              </div>
            </div>

            {/* Entry list */}
            <div className="rounded-xl border border-border overflow-hidden">
              <div className="divide-y divide-border">
                {filtered.length === 0 ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    No entries match &ldquo;{search}&rdquo;
                  </div>
                ) : (
                  filtered.map((entry, i) => (
                    <div
                      key={entry.id}
                      className={cn(
                        'flex items-center justify-between px-4 py-3 gap-4 transition-colors hover:bg-muted/30',
                        i % 2 === 0 ? 'bg-background' : 'bg-muted/10',
                      )}
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{entry.title || '(Untitled)'}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                          {entry.id}
                        </p>
                      </div>
                      {entry.studioUrl !== '#' && (
                        <a
                          href={entry.studioUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0"
                        >
                          <Button variant="outline" size="sm" className="gap-1.5 text-xs h-7">
                            Open in Studio
                            <ExternalLink className="w-3 h-3" />
                          </Button>
                        </a>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {filtered.length < entries.length && (
              <p className="text-xs text-muted-foreground mt-3 text-right">
                Showing {filtered.length} of {entries.length} entries
              </p>
            )}
          </>
        )}
      </main>
    </div>
  )
}
