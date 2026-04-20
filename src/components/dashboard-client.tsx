'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ThemeToggle } from '@/components/theme-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ExportButton } from '@/components/export-button'
import {
  fetchLocales,
  fetchModels,
  fetchLocalisationCounts,
  fetchTotalCount,
} from '@/lib/hygraph'
import type { HygraphLocale, HygraphModel, ModelLocalisationData } from '@/types'
import { Globe, LogOut, RefreshCw, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

function StatusIcon({ pct }: { pct: number }) {
  if (pct === 100) return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
  if (pct === 0) return <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
  return <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
}

function CellColor(pct: number) {
  if (pct === 100) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25'
  if (pct >= 75) return 'bg-amber-400/15 text-amber-700 dark:text-amber-400 hover:bg-amber-400/25'
  if (pct >= 1) return 'bg-orange-500/15 text-orange-700 dark:text-orange-400 hover:bg-orange-500/25'
  return 'bg-destructive/10 text-destructive hover:bg-destructive/20'
}

export function DashboardClient() {
  const router = useRouter()
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [locales, setLocales] = useState<HygraphLocale[]>([])
  const [data, setData] = useState<ModelLocalisationData[]>([])
  const [bootstrapping, setBootstrapping] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  const loadData = useCallback(async () => {
    if (!endpoint || !token) return
    setBootstrapping(true)
    setError(null)
    setData([])

    try {
      const creds = { endpoint, token }
      const [fetchedLocales, models] = await Promise.all([
        fetchLocales(creds),
        fetchModels(creds),
      ])

      setLocales(fetchedLocales)
      // Persist default locale for drill-down pages
      const defaultLocale = fetchedLocales.find((l) => l.isDefault)?.apiId ?? fetchedLocales[0]?.apiId ?? 'en'
      sessionStorage.setItem('hg_default_locale', defaultLocale)

      const initialData: ModelLocalisationData[] = models.map((m) => ({
        model: m,
        totalEntries: 0,
        locales: fetchedLocales.map((l) => ({
          locale: l.apiId,
          total: 0,
          translated: 0,
          percentage: 0,
        })),
        status: 'loading',
      }))
      setData(initialData)
      setBootstrapping(false)

      // Load each model progressively
      for (const model of models) {
        try {
          const [total, counts] = await Promise.all([
            fetchTotalCount(creds, model.apiId),
            fetchLocalisationCounts(
              creds,
              model.apiId,
              fetchedLocales.map((l) => l.apiId),
            ),
          ])

          setData((prev) =>
            prev.map((d) =>
              d.model.id === model.id
                ? {
                    ...d,
                    totalEntries: total,
                    locales: fetchedLocales.map((l) => ({
                      locale: l.apiId,
                      total,
                      translated: counts[l.apiId] ?? 0,
                      percentage: total > 0 ? Math.round(((counts[l.apiId] ?? 0) / total) * 100) : 100,
                    })),
                    status: 'done',
                  }
                : d,
            ),
          )
        } catch {
          setData((prev) =>
            prev.map((d) =>
              d.model.id === model.id ? { ...d, status: 'error' } : d,
            ),
          )
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project data')
      setBootstrapping(false)
    }
  }, [endpoint, token])

  useEffect(() => {
    if (endpoint && token) loadData()
  }, [endpoint, token, loadData])

  function handleDisconnect() {
    sessionStorage.removeItem('hg_endpoint')
    sessionStorage.removeItem('hg_token')
    router.push('/')
  }

  const overallPct =
    data.length > 0
      ? Math.round(
          data
            .filter((d) => d.status === 'done')
            .flatMap((d) => d.locales)
            .reduce((sum, l) => sum + l.percentage, 0) /
            Math.max(
              1,
              data.filter((d) => d.status === 'done').length * locales.length,
            ),
        )
      : 0

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border/60 bg-background/95 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
              <Globe className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-sm tracking-tight hidden sm:block">
              Localisation Checker
            </span>
          </Link>

          {/* Overall health */}
          {!bootstrapping && data.length > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground hidden sm:block">Overall</span>
              <Badge
                variant="secondary"
                className={cn(
                  'font-semibold tabular-nums',
                  overallPct === 100
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    : overallPct >= 75
                    ? 'bg-amber-400/15 text-amber-700 dark:text-amber-400'
                    : 'bg-destructive/10 text-destructive',
                )}
              >
                {overallPct}% complete
              </Badge>
            </div>
          )}

          <div className="flex items-center gap-2 ml-auto">
            <ExportButton data={data} locales={locales} />
            <Button variant="ghost" size="icon" onClick={loadData} className="w-8 h-8" title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </Button>
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDisconnect}
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:block">Disconnect</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
            <XCircle className="w-10 h-10 text-destructive" />
            <div>
              <p className="font-semibold">Failed to load project</p>
              <p className="text-sm text-muted-foreground mt-1">{error}</p>
            </div>
            <Button onClick={loadData} variant="outline" className="gap-2">
              <RefreshCw className="w-4 h-4" /> Try again
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-6">
              <h1 className="text-xl font-bold tracking-tight">Translation Coverage</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Click any cell to see which entries are missing that translation.
              </p>
            </div>

            {/* Matrix */}
            <div className="rounded-xl border border-border overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50 border-b border-border">
                      <th className="text-left px-4 py-3 font-semibold text-foreground sticky left-0 bg-muted/50 min-w-[180px] z-10">
                        Model
                      </th>
                      <th className="text-center px-3 py-3 font-semibold text-foreground min-w-[80px]">
                        Entries
                      </th>
                      {bootstrapping
                        ? Array.from({ length: 3 }).map((_, i) => (
                            <th key={i} className="px-3 py-3 min-w-[100px]">
                              <Skeleton className="h-4 w-16 mx-auto" />
                            </th>
                          ))
                        : locales.map((locale) => (
                            <th
                              key={locale.apiId}
                              className="text-center px-3 py-3 font-semibold text-foreground min-w-[100px]"
                            >
                              <div className="flex flex-col items-center gap-1">
                                <span>{locale.displayName}</span>
                                {locale.isDefault && (
                                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                                    default
                                  </Badge>
                                )}
                              </div>
                            </th>
                          ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {bootstrapping
                      ? Array.from({ length: 5 }).map((_, i) => (
                          <tr key={i} className="bg-background">
                            <td className="px-4 py-3 sticky left-0 bg-background">
                              <Skeleton className="h-4 w-32" />
                            </td>
                            <td className="px-3 py-3 text-center">
                              <Skeleton className="h-4 w-10 mx-auto" />
                            </td>
                            {Array.from({ length: 3 }).map((_, j) => (
                              <td key={j} className="px-3 py-3 text-center">
                                <Skeleton className="h-8 w-20 mx-auto rounded-lg" />
                              </td>
                            ))}
                          </tr>
                        ))
                      : data.map((row) => (
                          <tr
                            key={row.model.id}
                            className="bg-background hover:bg-muted/30 transition-colors"
                          >
                            <td className="px-4 py-3 sticky left-0 bg-background font-medium">
                              <div className="flex items-center gap-2">
                                {row.status === 'error' && (
                                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                                )}
                                {row.model.displayName}
                              </div>
                            </td>
                            <td className="px-3 py-3 text-center tabular-nums text-muted-foreground">
                              {row.status === 'loading' ? (
                                <Skeleton className="h-4 w-8 mx-auto" />
                              ) : row.status === 'error' ? (
                                <span className="text-destructive text-xs">—</span>
                              ) : (
                                row.totalEntries.toLocaleString()
                              )}
                            </td>
                            {locales.map((locale) => {
                              const localeData = row.locales.find((l) => l.locale === locale.apiId)
                              const pct = localeData?.percentage ?? 0
                              const translated = localeData?.translated ?? 0
                              const total = localeData?.total ?? 0
                              const missing = total - translated

                              if (row.status === 'loading') {
                                return (
                                  <td key={locale.apiId} className="px-3 py-3 text-center">
                                    <Skeleton className="h-8 w-20 mx-auto rounded-lg" />
                                  </td>
                                )
                              }

                              if (row.status === 'error') {
                                return (
                                  <td key={locale.apiId} className="px-3 py-3 text-center">
                                    <span className="text-xs text-muted-foreground">—</span>
                                  </td>
                                )
                              }

                              return (
                                <td key={locale.apiId} className="px-3 py-3 text-center">
                                  <Tooltip>
                                    <TooltipTrigger>
                                      {pct === 100 || total === 0 ? (
                                        <div
                                          className={cn(
                                            'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold tabular-nums',
                                            CellColor(pct),
                                          )}
                                        >
                                          <StatusIcon pct={pct} />
                                          {pct}%
                                        </div>
                                      ) : (
                                        <Link
                                          href={`/dashboard/${encodeURIComponent(row.model.apiId)}?locale=${locale.apiId}&displayName=${encodeURIComponent(row.model.displayName)}`}
                                          className={cn(
                                            'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold tabular-nums transition-colors cursor-pointer',
                                            CellColor(pct),
                                          )}
                                        >
                                          <StatusIcon pct={pct} />
                                          {pct}%
                                        </Link>
                                      )}
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="text-xs">
                                      {total === 0 ? (
                                        'No entries'
                                      ) : pct === 100 ? (
                                        `All ${total} entries translated`
                                      ) : (
                                        <span>
                                          <span className="font-semibold text-destructive">{missing} missing</span>
                                          {' '}of {total} entries · click to view
                                        </span>
                                      )}
                                    </TooltipContent>
                                  </Tooltip>
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Legend */}
            {!bootstrapping && (
              <div className="flex flex-wrap gap-4 mt-5 text-xs text-muted-foreground">
                {[
                  { color: 'bg-emerald-500/15', label: '100% — fully translated' },
                  { color: 'bg-amber-400/15', label: '75–99% — mostly done' },
                  { color: 'bg-orange-500/15', label: '1–74% — needs attention' },
                  { color: 'bg-destructive/10', label: '0% — not started' },
                ].map(({ color, label }) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <div className={cn('w-3 h-3 rounded-sm', color)} />
                    {label}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
