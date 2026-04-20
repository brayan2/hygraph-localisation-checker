'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { ThemeToggle } from '@/components/theme-toggle'
import {
  validateCredentials,
  fetchLocales,
  fetchModels,
  fetchTotalCount,
  fetchLocalisationCounts,
  fetchMissingForLocale,
} from '@/lib/hygraph'
import type { HygraphCredentials, HygraphLocale, HygraphModel, ModelLocalisationData, MissingEntry } from '@/types'
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Globe,
  Loader2,
  LogOut,
  RefreshCw,
  Search,
  ShieldCheck,
  XCircle,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type AppView = 'connect' | 'dashboard'

interface DrillDown {
  modelApiId: string
  modelType: string
  modelDisplayName: string
  locale: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pctColor(pct: number) {
  if (pct === 100) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25'
  if (pct >= 75) return 'bg-amber-400/15 text-amber-700 dark:text-amber-400 hover:bg-amber-400/25'
  if (pct >= 1) return 'bg-orange-500/15 text-orange-700 dark:text-orange-400 hover:bg-orange-500/25'
  return 'bg-destructive/10 text-destructive hover:bg-destructive/20'
}

function StatusIcon({ pct }: { pct: number }) {
  if (pct === 100) return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
  if (pct === 0) return <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
  return <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
}

// ─── Root component ───────────────────────────────────────────────────────────

export function AppClient() {
  const [view, setView] = useState<AppView>('connect')
  const [creds, setCreds] = useState<HygraphCredentials | null>(null)
  const [defaultLocale, setDefaultLocale] = useState('en')
  const [drillDown, setDrillDown] = useState<DrillDown | null>(null)

  function handleConnected(c: HygraphCredentials, dl: string) {
    setCreds(c)
    setDefaultLocale(dl)
    setView('dashboard')
  }

  function handleDisconnect() {
    setCreds(null)
    setView('connect')
    setDrillDown(null)
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header
        view={view}
        onDisconnect={handleDisconnect}
      />

      <main className="flex-1">
        {view === 'connect' && (
          <ConnectView onConnected={handleConnected} />
        )}
        {view === 'dashboard' && creds && (
          <DashboardView
            creds={creds}
            defaultLocale={defaultLocale}
            onDrillDown={setDrillDown}
          />
        )}
      </main>

      {/* Drill-down sheet — slides over the dashboard */}
      <Sheet open={!!drillDown} onOpenChange={(open) => { if (!open) setDrillDown(null) }}>
        <SheetContent side="right" className="w-full sm:max-w-2xl p-0 flex flex-col gap-0">
          {drillDown && creds && (
            <DrillDownPanel
              creds={creds}
              drillDown={drillDown}
              defaultLocale={defaultLocale}
              onClose={() => setDrillDown(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({ view, onDisconnect }: { view: AppView; onDisconnect: () => void }) {
  return (
    <header className="border-b border-border/60 bg-background/95 backdrop-blur sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
            <Globe className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-semibold text-sm tracking-tight">Localisation Checker</span>
          <span className="text-xs text-muted-foreground hidden sm:block">by Hygraph</span>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <ThemeToggle />
          {view === 'dashboard' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDisconnect}
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:block">Disconnect</span>
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}

// ─── Connect view ─────────────────────────────────────────────────────────────

function ConnectView({ onConnected }: { onConnected: (creds: HygraphCredentials, defaultLocale: string) => void }) {
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const ep = endpoint.trim()
      const tk = token.trim()

      if (!ep.startsWith('https://')) throw new Error('Endpoint must start with https://')

      const creds = { endpoint: ep, token: tk }
      await validateCredentials(creds)

      // Fetch default locale immediately so we have it ready
      let dl = 'en'
      try {
        const locales = await fetchLocales(creds)
        dl = locales[0]?.apiId ?? 'en'
      } catch { /* will retry on dashboard load */ }

      onConnected(creds, dl)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed'
      if (msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('unauthorized')) {
        setError('Invalid token — make sure it has Content API read access.')
      } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setError('Cannot reach the endpoint. Check the URL and try again.')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="flex flex-col items-center justify-center px-4 py-16 sm:py-24 min-h-[calc(100vh-3.5rem)]">
      <div className="w-full max-w-xl mx-auto text-center mb-10">
        <div className="inline-flex items-center gap-2 bg-primary/10 text-primary text-xs font-medium px-3 py-1 rounded-full mb-6">
          <Zap className="w-3 h-3" />
          Free &amp; open source
        </div>
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight mb-4 leading-tight">
          Find missing translations{' '}
          <span className="text-primary">before they hit production</span>
        </h1>
        <p className="text-muted-foreground text-base sm:text-lg leading-relaxed">
          Connect your Hygraph project and instantly see which content entries are missing
          translations — model by model, locale by locale.
        </p>
      </div>

      <Card className="w-full max-w-md shadow-lg shadow-black/5 dark:shadow-black/20">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Connect your project</CardTitle>
          <CardDescription>
            Credentials stay in memory only and are never sent to any server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="endpoint">Content API Endpoint</Label>
              <Input
                id="endpoint"
                type="url"
                placeholder="https://ap-southeast-2.cdn.hygraph.com/content/…/master"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                required
                disabled={loading}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Project Settings → API Access → Endpoints
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="token">API Token</Label>
              <div className="relative">
                <Input
                  id="token"
                  type={showToken ? 'text' : 'password'}
                  placeholder="eyJ…"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                  disabled={loading}
                  className="font-mono text-sm pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Permanent Auth Token with read access — no write permissions needed
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-destructive text-sm bg-destructive/10 rounded-lg px-3 py-2.5">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" className="w-full gap-2" disabled={loading || !endpoint || !token}>
              {loading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Connecting…</>
              ) : (
                'Check my project'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-center gap-3 mt-8">
        {[
          { icon: ShieldCheck, label: 'Read-only access' },
          { icon: Globe, label: 'All locales supported' },
          { icon: Zap, label: 'No account required' },
        ].map(({ icon: Icon, label }) => (
          <div key={label} className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 px-3 py-1.5 rounded-full">
            <Icon className="w-3 h-3" />
            {label}
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── Dashboard view ───────────────────────────────────────────────────────────

function DashboardView({
  creds,
  defaultLocale,
  onDrillDown,
}: {
  creds: HygraphCredentials
  defaultLocale: string
  onDrillDown: (d: DrillDown) => void
}) {
  const [locales, setLocales] = useState<HygraphLocale[]>([])
  const [data, setData] = useState<ModelLocalisationData[]>([])
  const [bootstrapping, setBootstrapping] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setBootstrapping(true)
    setError(null)
    setData([])

    try {
      const [fetchedLocales, models] = await Promise.all([
        fetchLocales(creds),
        fetchModels(creds),
      ])

      setLocales(fetchedLocales)

      const initial: ModelLocalisationData[] = models.map((m) => ({
        model: m,
        totalEntries: 0,
        locales: fetchedLocales.map((l) => ({ locale: l.apiId, total: 0, translated: 0, percentage: 0 })),
        status: 'loading',
      }))
      setData(initial)
      setBootstrapping(false)

      for (const model of models) {
        try {
          const [total, counts] = await Promise.all([
            fetchTotalCount(creds, model.apiId),
            fetchLocalisationCounts(creds, model.apiId, fetchedLocales.map((l) => l.apiId)),
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
          setData((prev) => prev.map((d) => d.model.id === model.id ? { ...d, status: 'error' } : d))
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project data')
      setBootstrapping(false)
    }
  }, [creds])

  useEffect(() => { loadData() }, [loadData])

  const overallPct = data.length > 0
    ? Math.round(
        data.filter((d) => d.status === 'done').flatMap((d) => d.locales).reduce((s, l) => s + l.percentage, 0) /
        Math.max(1, data.filter((d) => d.status === 'done').length * locales.length),
      )
    : 0

  function exportCSV() {
    const rows = [
      ['Model', 'Total', ...locales.map((l) => l.displayName + ' (%)')],
      ...data.filter((d) => d.status === 'done').map((row) => [
        row.model.displayName,
        String(row.totalEntries),
        ...locales.map((l) => {
          const ld = row.locales.find((x) => x.locale === l.apiId)
          return (ld?.percentage ?? 0) + '%'
        }),
      ]),
    ]
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'localisation-coverage.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const hasData = data.some((d) => d.status === 'done')

  return (
    <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Translation Coverage</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {bootstrapping ? 'Loading your project…' : `${data.length} localised models · click any cell to inspect`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!bootstrapping && (
            <Badge
              variant="secondary"
              className={cn(
                'font-semibold tabular-nums hidden sm:flex',
                overallPct === 100 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                  : overallPct >= 75 ? 'bg-amber-400/15 text-amber-700 dark:text-amber-400'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {overallPct}% overall
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={loadData} className="gap-1.5 h-8">
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="hidden sm:block">Refresh</span>
          </Button>
          <Button variant="outline" size="sm" onClick={exportCSV} disabled={!hasData} className="gap-1.5 h-8">
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:block">Export CSV</span>
          </Button>
        </div>
      </div>

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
          <div className="rounded-xl border border-border overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b border-border">
                    <th className="text-left px-4 py-3 font-semibold sticky left-0 bg-muted/50 min-w-[180px] z-10">
                      Model
                    </th>
                    <th className="text-center px-3 py-3 font-semibold min-w-[72px]">Entries</th>
                    {bootstrapping
                      ? Array.from({ length: 3 }).map((_, i) => (
                          <th key={i} className="px-3 py-3 min-w-[110px]">
                            <Skeleton className="h-4 w-16 mx-auto" />
                          </th>
                        ))
                      : locales.map((locale) => (
                          <th key={locale.apiId} className="text-center px-3 py-3 font-semibold min-w-[110px]">
                            <div className="flex flex-col items-center gap-1">
                              <span>{locale.displayName}</span>
                              {locale.isDefault && (
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">default</Badge>
                              )}
                            </div>
                          </th>
                        ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {bootstrapping
                    ? Array.from({ length: 6 }).map((_, i) => (
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
                        <tr key={row.model.id} className="bg-background hover:bg-muted/30 transition-colors">
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
                            ) : row.status === 'error' ? '—' : row.totalEntries.toLocaleString()}
                          </td>
                          {locales.map((locale) => {
                            const ld = row.locales.find((l) => l.locale === locale.apiId)
                            const pct = ld?.percentage ?? 0
                            const total = ld?.total ?? 0
                            const missing = total - (ld?.translated ?? 0)

                            if (row.status === 'loading') {
                              return (
                                <td key={locale.apiId} className="px-3 py-3 text-center">
                                  <Skeleton className="h-8 w-20 mx-auto rounded-lg" />
                                </td>
                              )
                            }
                            if (row.status === 'error') {
                              return <td key={locale.apiId} className="px-3 py-3 text-center text-muted-foreground text-xs">—</td>
                            }

                            const canDrillDown = pct < 100 && total > 0

                            return (
                              <td key={locale.apiId} className="px-3 py-3 text-center">
                                <Tooltip>
                                  <TooltipTrigger>
                                    <button
                                      onClick={() => {
                                        if (!canDrillDown) return
                                        const singular = row.model.apiId.replace(/ies$/, 'y').replace(/s$/, '')
                                        const modelType = singular.charAt(0).toUpperCase() + singular.slice(1)
                                        onDrillDown({
                                          modelApiId: row.model.apiId,
                                          modelType,
                                          modelDisplayName: row.model.displayName,
                                          locale: locale.apiId,
                                        })
                                      }}
                                      disabled={!canDrillDown}
                                      className={cn(
                                        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold tabular-nums transition-colors',
                                        pctColor(pct),
                                        canDrillDown ? 'cursor-pointer' : 'cursor-default',
                                      )}
                                    >
                                      <StatusIcon pct={pct} />
                                      {pct}%
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="text-xs">
                                    {total === 0 ? 'No entries' : pct === 100
                                      ? `All ${total} entries translated`
                                      : <span><span className="font-semibold text-destructive">{missing} missing</span> of {total} · click to view</span>}
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
            <div className="flex flex-wrap gap-4 mt-4 text-xs text-muted-foreground">
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
    </div>
  )
}

// ─── Drill-down panel (inside Sheet) ─────────────────────────────────────────

function DrillDownPanel({
  creds,
  drillDown,
  defaultLocale,
  onClose,
}: {
  creds: HygraphCredentials
  drillDown: DrillDown
  defaultLocale: string
  onClose: () => void
}) {
  const [entries, setEntries] = useState<MissingEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setProgress(0)
    setEntries([])
    try {
      const missing = await fetchMissingForLocale(
        creds,
        drillDown.modelApiId,
        drillDown.modelType,
        drillDown.locale,
        defaultLocale,
        (n) => setProgress(n),
      )
      setEntries(missing)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [creds, drillDown, defaultLocale])

  useEffect(() => { load() }, [load])

  const filtered = entries.filter(
    (e) =>
      e.title.toLowerCase().includes(search.toLowerCase()) ||
      e.id.toLowerCase().includes(search.toLowerCase()),
  )

  function exportCSV() {
    const rows = [['Entry ID', 'Title', 'Missing Locale', 'Studio URL'],
      ...entries.map((e) => [e.id, e.title, drillDown.locale, e.studioUrl])]
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `missing-${drillDown.locale}-${drillDown.modelApiId}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Sheet header */}
      <SheetHeader className="px-6 py-5 border-b border-border shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <SheetTitle className="text-base">
            Missing <span className="text-primary">{drillDown.locale.replace('_', '-')}</span> — {drillDown.modelDisplayName}
          </SheetTitle>
        </div>
        <SheetDescription>
          Entries that have no {drillDown.locale.replace(/_/g, '-')} localisation
        </SheetDescription>
      </SheetHeader>

      {/* Search + actions */}
      {!loading && entries.length > 0 && (
        <div className="flex items-center gap-2 px-6 py-3 border-b border-border shrink-0">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search entries…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>
          <Badge variant="secondary" className="bg-destructive/10 text-destructive shrink-0">
            {entries.length} missing
          </Badge>
          <Button variant="outline" size="sm" onClick={exportCSV} className="gap-1.5 h-8 shrink-0">
            <Download className="w-3.5 h-3.5" />
            CSV
          </Button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-4 py-16 px-6 text-center">
            <XCircle className="w-8 h-8 text-destructive" />
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={load} variant="outline" size="sm" className="gap-2">
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="px-6 py-5 space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Scanning entries{progress > 0 ? ` (${progress} checked)` : '…'}
            </div>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between py-2">
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <Skeleton className="h-7 w-24 rounded-lg" />
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-600" />
            </div>
            <p className="font-semibold">All entries are translated!</p>
            <p className="text-sm text-muted-foreground">
              Every {drillDown.modelDisplayName} entry has a {drillDown.locale.replace(/_/g, '-')} localisation.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No entries match &ldquo;{search}&rdquo;
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((entry, i) => (
              <div
                key={entry.id}
                className={cn(
                  'flex items-center justify-between px-6 py-3 gap-4 hover:bg-muted/30 transition-colors',
                  i % 2 === 0 ? 'bg-background' : 'bg-muted/10',
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{entry.title || '(Untitled)'}</p>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{entry.id}</p>
                </div>
                {entry.studioUrl !== '#' && (
                  <a href={entry.studioUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                    <Button variant="outline" size="sm" className="gap-1.5 text-xs h-7">
                      Studio <ExternalLink className="w-3 h-3" />
                    </Button>
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer count */}
      {!loading && filtered.length < entries.length && (
        <div className="px-6 py-2 border-t border-border text-xs text-muted-foreground text-right shrink-0">
          Showing {filtered.length} of {entries.length}
        </div>
      )}
    </div>
  )
}
