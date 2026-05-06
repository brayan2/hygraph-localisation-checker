import type {
  HygraphCredentials,
  HygraphLocale,
  HygraphModel,
  MissingEntry,
  EntryListItem,
  FieldCoverageItem,
  EntryFieldCoverage,
  HygraphStage,
} from '@/types'

async function gql(
  endpoint: string,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  })

  let json: any
  try {
    json = await res.json()
  } catch {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    throw new Error('Invalid JSON response')
  }

  if (!res.ok) {
    const errorMsg = json.errors?.[0]?.message || `${res.status} ${res.statusText}`
    throw new Error(errorMsg)
  }
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data
}

function unwrapType(ref: { kind: string; name?: string; ofType?: unknown }): string | null {
  if (!ref) return null
  if (ref.name) return ref.name
  if (ref.ofType) return unwrapType(ref.ofType as typeof ref)
  return null
}

function extractProjectId(endpoint: string): string {
  return endpoint.match(/\/content\/([a-zA-Z0-9]+)\//)?.[1] ?? ''
}

const SYSTEM_FIELDS = new Set([
  'id', 'stage', 'locale', 'localizations', 'documentInStages',
  'createdAt', 'updatedAt', 'publishedAt', 'createdBy', 'updatedBy', 'publishedBy',
  'scheduledIn', 'history',
])

// ─── Public API ───────────────────────────────────────────────────────────────

export async function validateCredentials(creds: HygraphCredentials): Promise<void> {
  await gql(creds.endpoint, creds.token, `{ __typename }`)
}

export async function fetchLocales(creds: HygraphCredentials): Promise<HygraphLocale[]> {
  const enumData = await gql(creds.endpoint, creds.token, `
    query { __type(name: "Locale") { enumValues { name } } }
  `)
  const values: Array<{ name: string }> = enumData?.__type?.enumValues ?? []
  if (!values.length) throw new Error('No locales found — is localisation enabled on this project?')

  let defaultApiId = values[0]?.name
  try {
    const assetData = await gql(creds.endpoint, creds.token, `
      query { entries: assets(first: 1) { locale } }
    `)
    const detected = (assetData.entries?.[0] as { locale?: string } | undefined)?.locale
    if (detected && values.some(v => v.name === detected)) defaultApiId = detected
  } catch { /* fallback */ }

  return values.map(v => ({
    id: v.name,
    apiId: v.name,
    displayName: v.name.replace(/_/g, '-'),
    isDefault: v.name === defaultApiId,
  }))
}

export async function fetchModels(creds: HygraphCredentials): Promise<HygraphModel[]> {
  const [typesData, queryData] = await Promise.all([
    gql(creds.endpoint, creds.token, `
      query { __schema { types { name kind fields { name } } } }
    `),
    gql(creds.endpoint, creds.token, `
      query { __schema { queryType { fields { name } } } }
    `),
  ])

  const localizedTypes = new Set<string>()
  for (const t of typesData.__schema.types as Array<{
    name: string; kind: string; fields: Array<{ name: string }> | null
  }>) {
    if (t.kind === 'OBJECT' && !t.name.startsWith('__') && t.fields?.some(f => f.name === 'localizations'))
      localizedTypes.add(t.name)
  }

  const allFieldNames = new Set<string>(
    (queryData.__schema.queryType.fields as Array<{ name: string }>).map(f => f.name),
  )

  function pluralApiId(typeName: string): string | null {
    const c = typeName.charAt(0).toLowerCase() + typeName.slice(1)
    if (allFieldNames.has(c) && allFieldNames.has(c + 'Connection')) return c
    if (allFieldNames.has(c + 's') && allFieldNames.has(c + 'sConnection')) return c + 's'
    if (c.endsWith('y')) {
      const ies = c.slice(0, -1) + 'ies'
      if (allFieldNames.has(ies) && allFieldNames.has(ies + 'Connection')) return ies
    }
    if (allFieldNames.has(c + 'es') && allFieldNames.has(c + 'esConnection')) return c + 'es'
    return null
  }

  const models: HygraphModel[] = []
  for (const typeName of localizedTypes) {
    const apiId = pluralApiId(typeName)
    if (apiId) {
      models.push({
        id: typeName,
        apiId,
        displayName: typeName.replace(/([A-Z])/g, ' $1').trim(),
        isLocalized: true,
      })
    }
  }
  return models
}

export async function fetchTotalCount(
  creds: HygraphCredentials,
  modelApiId: string,
  defaultLocale: string,
  stage: HygraphStage = 'PUBLISHED',
): Promise<number> {
  if (stage === 'BOTH') return await fetchTotalCountRaw(creds, modelApiId, defaultLocale, 'DRAFT')
  if (stage === 'PUBLISHED') return await fetchTotalCountRaw(creds, modelApiId, defaultLocale, 'PUBLISHED')

  // DRAFT stage = Draft Only
  const [draft, pub] = await Promise.all([
    fetchTotalCountRaw(creds, modelApiId, defaultLocale, 'DRAFT'),
    fetchTotalCountRaw(creds, modelApiId, defaultLocale, 'PUBLISHED'),
  ])
  return Math.max(0, draft - pub)
}

async function fetchTotalCountRaw(
  creds: HygraphCredentials,
  modelApiId: string,
  defaultLocale: string,
  stage: 'DRAFT' | 'PUBLISHED',
): Promise<number> {
  try {
    const data = await gql(creds.endpoint, creds.token, `
      query TotalCount {
        result: ${modelApiId}Connection(stage: ${stage}) {
          aggregate { count }
        }
      }
    `)
    return data.result?.aggregate?.count ?? 0
  } catch {
    let total = 0
    let skip = 0
    const PAGE = 1000
    while (true) {
      try {
        const data = await gql(creds.endpoint, creds.token, `
          query CountFallback($skip: Int!) {
            entries: ${modelApiId}(stage: ${stage}, locales: [${defaultLocale}], first: ${PAGE}, skip: $skip) { id }
          }
        `, { skip })
        const count = (data.entries as Array<unknown>)?.length ?? 0
        total += count
        if (count < PAGE) break
        skip += PAGE
        if (skip > 10000) break
      } catch { break }
    }
    return total
  }
}

export async function fetchLocalisationCounts(
  creds: HygraphCredentials,
  modelApiId: string,
  locales: string[],
  total: number,
  stage: HygraphStage = 'PUBLISHED',
): Promise<Record<string, number>> {
  if (stage === 'BOTH') {
    return await fetchLocalisationCountsRaw(creds, modelApiId, locales, total, 'DRAFT')
  }
  
  const countsDraft = await fetchLocalisationCountsRaw(creds, modelApiId, locales, total, 'DRAFT')
  const countsPub = await fetchLocalisationCountsRaw(creds, modelApiId, locales, total, 'PUBLISHED')

  if (stage === 'PUBLISHED') return countsPub
  
  // DRAFT stage now means "Draft ONLY" (Not Published)
  const draftOnly: Record<string, number> = {}
  for (const l of locales) {
    draftOnly[l] = Math.max(0, (countsDraft[l] ?? 0) - (countsPub[l] ?? 0))
  }
  return draftOnly
}

async function fetchLocalisationCountsRaw(
  creds: HygraphCredentials,
  modelApiId: string,
  locales: string[],
  total: number,
  stage: 'DRAFT' | 'PUBLISHED',
): Promise<Record<string, number>> {
  try {
  const aliases = locales
    .map(
      (l, i) => `l${i}: ${modelApiId}Connection(stage: ${stage}, where: { localizations_some: { locale: ${l} } }) {
        aggregate { count }
      }`,
    )
    .join('\n')
    const data = await gql(creds.endpoint, creds.token, `query { ${aliases} }`)
    const counts: Record<string, number> = {}
    for (let i = 0; i < locales.length; i++) counts[locales[i]] = data[`l${i}`]?.aggregate?.count ?? 0
    return counts
  } catch {
    return await countViaScan(creds, modelApiId, locales, total, stage)
  }
}

async function countViaScan(
  creds: HygraphCredentials,
  modelApiId: string,
  locales: string[],
  total: number,
  stage: 'DRAFT' | 'PUBLISHED',
): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(locales.map(l => [l, 0]))
  const PAGE = 500
  let skip = 0
  while (skip < total) {
    const aliases = locales
      .map((l, i) => `l${i}: ${modelApiId}(stage: ${stage}, locales: [${l}], first: $first, skip: $skip) { locale }`)
      .join('\n')
    const data = await gql(creds.endpoint, creds.token, `query Scan($first: Int!, $skip: Int!) { ${aliases} }`, { first: PAGE, skip })
    let anyFull = false
    for (let i = 0; i < locales.length; i++) {
      const entries = (data[`l${i}`] as Array<{ locale: string }>) ?? []
      counts[locales[i]] += entries.filter(e => e.locale === locales[i]).length
      if (entries.length >= PAGE) anyFull = true
    }
    if (!anyFull) break
    skip += PAGE
  }
  return counts
}

async function fetchTitleField(creds: HygraphCredentials, modelType: string): Promise<string | null> {
  try {
    const data = await gql(creds.endpoint, creds.token, `
      query { __type(name: "${modelType}") {
        fields { name type { kind name ofType { kind name } } }
      } }
    `)
    const fields = (data.__type?.fields ?? []) as any[]
    for (const c of ['title', 'name', 'headline', 'label', 'slug', 'displayName']) {
      const f = fields.find(x => x.name === c)
      if (f && (unwrapType(f.type) === 'String')) return c
    }
  } catch { /* ignore */ }
  return null
}

export async function fetchEntryList(
  creds: HygraphCredentials,
  modelApiId: string,
  modelType: string,
  locales: HygraphLocale[],
  defaultLocale: string,
  first: number,
  skip: number,
  stage: HygraphStage = 'PUBLISHED',
): Promise<{ entries: EntryListItem[]; total: number }> {
  // If user wants "Draft Only" (DRAFT), we query DRAFT and then filter later if we had to?
  // Actually, let's keep it simple: ALL/DRAFT/PUBLISHED query the corresponding Hygraph stage.
  const s = stage === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT'
  const titleField = await fetchTitleField(creds, modelType)
  const allLocaleIds = locales.map(l => l.apiId).join(', ')
  const projectId = extractProjectId(creds.endpoint)
  const data = await gql(creds.endpoint, creds.token, `
    query EntryList($first: Int!, $skip: Int!) {
      entries: ${modelApiId}(stage: ${s}, locales: [${defaultLocale}, ${allLocaleIds}], first: $first, skip: $skip) {
        id
        ${titleField ?? ''}
        documentInStages { stage }
        localizations(locales: [${allLocaleIds}]) { locale stage }
      }
    }
  `, { first, skip })

  const rawEntries = (data.entries ?? []) as any[]
  let items = rawEntries.map(e => ({
    id: e.id,
    title: titleField ? String(e[titleField] ?? '') || e.id : e.id,
    localePresentMap: Object.fromEntries(
      (e.localizations as any[]).map(loc => [loc.locale, true]),
    ),
    stages: (e.documentInStages as any[]).map(s => s.stage),
    studioUrl: projectId
      ? `https://app.hygraph.com/projects/${projectId}/master/content/${modelType}/view/${modelApiId}/${e.id}`
      : '#',
  }))

  if (stage === 'DRAFT') {
    // Strictly Draft Only: exists in DRAFT but NOT in PUBLISHED
    items = items.filter(e => e.stages.includes('DRAFT') && !e.stages.includes('PUBLISHED'))
  }

  return { entries: items, total: 0 }
}

export async function fetchLocalizableFields(
  creds: HygraphCredentials,
  modelType: string,
): Promise<Array<{ name: string; typeName: string; isRichText: boolean }>> {
  // Fix: Instead of checking isLocalized on the base type (which fails on some APIs),
  // we check what fields exist on the ${Model}Localization type.
  try {
    const data = await gql(creds.endpoint, creds.token, `
      query { __type(name: "${modelType}Localization") { fields { name type { kind name ofType { kind name } } } } }
    `)
    const fields = (data?.__type?.fields ?? []) as any[]
    if (fields.length > 0) {
      return fields
        .filter(f => !SYSTEM_FIELDS.has(f.name))
        .map(f => {
          const typeName = unwrapType(f.type) ?? ''
          return {
            name: f.name,
            typeName,
            isRichText: typeName === 'RichText' || typeName === 'Json' || f.type.kind === 'OBJECT' || f.type.kind === 'LIST',
          }
        })
    }
  } catch { /* fallback */ }

  // Fallback: Check base type fields but WITHOUT isLocalized (less accurate)
  const dataBase = await gql(creds.endpoint, creds.token, `
    query { __type(name: "${modelType}") { fields { name type { kind name ofType { kind name } } } } }
  `)
  return ((dataBase?.__type?.fields ?? []) as any[])
    .filter(f => !SYSTEM_FIELDS.has(f.name))
    .map(f => {
      const typeName = unwrapType(f.type) ?? ''
      return { name: f.name, typeName, isRichText: typeName === 'RichText' || typeName === 'Json' }
    })
}

export async function fetchEntryFieldCoverage(
  creds: HygraphCredentials,
  modelApiId: string,
  modelType: string,
  entryId: string,
  defaultLocale: string,
  targetLocale: string,
  stage: HygraphStage = 'PUBLISHED',
): Promise<EntryFieldCoverage> {
  const s = stage === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT'
  const [localizableFields, titleField] = await Promise.all([
    fetchLocalizableFields(creds, modelType),
    fetchTitleField(creds, modelType),
  ])

  const isSameLocale = defaultLocale === targetLocale
  const localesToFetch = isSameLocale ? [defaultLocale] : [defaultLocale, targetLocale]
  const fieldSelections = localizableFields
    .map(f => {
      if (f.isRichText) {
        // Handle RichText, Json, and other composite objects
        // We select common fields or just check existence via a simple property
        if (f.typeName === 'RichText') return `${f.name} { text html json }`
        if (f.typeName === 'Json') return f.name
        // For Components/References, use __typename which is valid on all object types
        return `${f.name} { __typename }`
      }
      return f.name
    })
    .join('\n')

  let entry: Record<string, unknown> | null = null
  if (localizableFields.length > 0) {
    const data = await gql(creds.endpoint, creds.token, `
      query EntryFields($id: ID!) {
        entries: ${modelApiId}(stage: ${s}, locales: [${localesToFetch.join(', ')}], where: { id: $id }) {
          id
          ${titleField ?? ''}
          localizations(locales: [${localesToFetch.join(', ')}]) {
            locale
            ${fieldSelections}
          }
        }
      }
    `, { id: entryId })
    entry = (data.entries as any[])?.[0] ?? null
  }

  if (!entry) throw new Error('Entry not found in selected stage')

  function stringify(v: unknown): string | null {
    if (v === null || v === undefined) return null
    if (typeof v === 'object') {
      const obj = v as any
      if (obj.text || obj.html || obj.json) return obj.text || obj.html || (obj.json ? JSON.stringify(obj.json) : null)
      if (obj.id || obj.url) return obj.id || obj.url
      // If it's a non-empty object but we don't know the fields, just return a marker
      return Object.keys(obj).length > 0 ? '[Complex Content]' : null
    }
    const s = String(v)
    return s === '' ? null : s
  }

  const locs = (entry.localizations as any[]) ?? []
  const defaultLoc = locs.find(l => l.locale === defaultLocale) ?? {}
  const targetLoc = locs.find(l => l.locale === targetLocale) ?? null

  const fields: FieldCoverageItem[] = localizableFields.map(f => {
    const defaultValue = stringify(defaultLoc[f.name])
    const targetValue = targetLoc ? stringify(targetLoc[f.name]) : null
    return {
      name: f.name,
      displayName: f.name.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim(),
      typeName: f.typeName,
      defaultValue,
      targetValue,
      isCovered: targetValue !== null,
    }
  })

  return {
    entryId,
    entryTitle: titleField ? String(entry[titleField] ?? '') || entryId : entryId,
    defaultLocale,
    targetLocale,
    fields,
    coveredCount: fields.filter(f => f.isCovered).length,
    totalCount: fields.length,
    entryHasLocale: targetLoc !== null,
  }
}

export async function fetchLocalizationStageHealth(
  creds: HygraphCredentials,
  modelApiId: string,
  locales: string[],
): Promise<{ locale: string; published: number; draftOnly: number }[] | null> {
  // Strategy 1: Connection Aggregate (Fastest)
  try {
    const aliases = locales.flatMap((l, i) => [
      `d${i}: ${modelApiId}Connection(stage: DRAFT, where: { localizations_some: { locale: ${l} } }) { aggregate { count } }`,
      `p${i}: ${modelApiId}Connection(stage: PUBLISHED, where: { localizations_some: { locale: ${l} } }) { aggregate { count } }`,
    ]).join('\n')
    const data = await gql(creds.endpoint, creds.token, `query { ${aliases} }`)
    return locales.map((l, i) => {
      const draft = data[`d${i}`]?.aggregate?.count ?? 0
      const published = data[`p${i}`]?.aggregate?.count ?? 0
      return { locale: l, published, draftOnly: Math.max(0, draft - published) }
    })
  } catch { /* Fallback to Strategy 2 */ }

  // Strategy 2: Iterative scanning (Resilient but slower)
  try {
    const PAGE = 100
    const counts = Object.fromEntries(locales.map(l => [l, { d: 0, p: 0 }]))
    let skip = 0
    let hasMore = true
    while (hasMore) {
      const data = await gql(creds.endpoint, creds.token, `
        query {
          entries: ${modelApiId}(stage: DRAFT, first: ${PAGE}, skip: ${skip}) {
            id
            documentInStages { stage }
            localizations { locale stage }
          }
        }
      `)
      const entries = (data.entries ?? []) as any[]
      for (const e of entries) {
        for (const l of locales) {
          const locs = (e.localizations as any[]).filter(loc => loc.locale === l)
          if (locs.some(loc => loc.stage === 'DRAFT')) counts[l].d++
          if (locs.some(loc => loc.stage === 'PUBLISHED')) counts[l].p++
        }
      }
      hasMore = entries.length === PAGE
      skip += PAGE
      if (skip > 1000) break // Safety cap for scan
    }
    return locales.map(l => ({
      locale: l,
      published: counts[l].p,
      draftOnly: Math.max(0, counts[l].d - counts[l].p),
    }))
  } catch { return null }
}

export async function fetchFieldHealth(
  creds: HygraphCredentials,
  modelApiId: string,
  modelType: string,
  defaultLocale: string,
): Promise<{ fieldName: string; status: 'ok' | 'error'; error?: string }[]> {
  const fields = await fetchLocalizableFields(creds, modelType)
  const results: { fieldName: string; status: 'ok' | 'error'; error?: string }[] = []

  for (const f of fields) {
    try {
      const sel = f.isRichText
        ? (f.typeName === 'RichText' ? `${f.name} { text }` : (f.typeName === 'Json' ? f.name : `${f.name} { __typename }`))
        : f.name
      
      // Try to query a single entry with this specific field
      await gql(creds.endpoint, creds.token, `
        query TestField($locs: [Locale!]!) {
          entries: ${modelApiId}(stage: DRAFT, locales: $locs, first: 1) { ${sel} }
        }
      `, { locs: [defaultLocale] })
      results.push({ fieldName: f.name, status: 'ok' })
    } catch (err) {
      results.push({ fieldName: f.name, status: 'error', error: err instanceof Error ? err.message : 'Unknown error' })
    }
  }
  return results
}

export async function fetchMissingForLocale() {
  return []
}
