export interface HygraphCredentials {
  endpoint: string
  token: string
}

export type HygraphStage = 'DRAFT' | 'PUBLISHED'

export interface HygraphLocale {
  id: string
  apiId: string
  displayName: string
  isDefault: boolean
}

export interface HygraphModel {
  id: string
  apiId: string
  displayName: string
  isLocalized: boolean
}

export interface LocaleCount {
  locale: string
  total: number
  translated: number
  percentage: number
}

export interface ModelLocalisationData {
  model: HygraphModel
  totalEntries: number
  locales: LocaleCount[]
  status: 'loading' | 'done' | 'error'
  stage: HygraphStage
}

export interface MissingEntry {
  id: string
  title: string
  missingLocales: string[]
  studioUrl: string
}

export interface DrillDownData {
  modelApiId: string
  modelDisplayName: string
  locale: string
  missing: MissingEntry[]
  total: number
}

export interface StageHealthCount {
  locale: string
  published: number
  draftOnly: number
}

export interface ModelStageHealth {
  model: HygraphModel
  counts: StageHealthCount[] | null
  status: 'loading' | 'done' | 'error'
}

// ─── Hierarchical drill-down ──────────────────────────────────────────────────

export interface EntryListItem {
  id: string
  title: string
  /** locale apiId → true if that locale exists on this entry */
  localePresentMap: Record<string, boolean>
  studioUrl: string
}

export interface FieldCoverageItem {
  name: string
  displayName: string
  typeName: string
  defaultValue: string | null
  targetValue: string | null
  isCovered: boolean
}

export interface EntryFieldCoverage {
  entryId: string
  entryTitle: string
  defaultLocale: string
  targetLocale: string
  fields: FieldCoverageItem[]
  coveredCount: number
  totalCount: number
  entryHasLocale: boolean
}
