import type {
  HygraphCredentials,
  HygraphLocale,
  HygraphModel,
  MissingEntry,
  EntryListItem,
  FieldCoverageItem,
  EntryFieldCoverage,
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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const json = await res.json()
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
  // Fetch enum values and schema query args in one round-trip
  const data = await gql(creds.endpoint, creds.token, `
    query {
      __type(name: "Locale") { enumValues { name } }
      __schema { queryType { fields { name args { name defaultValue } } } }
    }
  `)
  const values: Array<{ name: string }> = data?.__type?.enumValues ?? []
  if (!values.length) throw new Error('No locales found — is localisation enabled on this project?')

  // Read the actual default locale from the schema: the 'locales' arg on any
  // localized query field has a defaultValue like "[en]" or "[en_US]"
  let defaultApiId = values[0]?.name
  try {
    const fields: Array<{ args: Array<{ name: string; defaultValue: string | null }> }> =
      data.__schema?.queryType?.fields ?? []
    outer: for (const f of fields) {
      for (const a of f.args) {
        if (a.name === 'locales' && a.defaultValue) {
          const m = a.defaultValue.match(/\b(\w+)\b/)
          if (m?.[1] && values.some(v => v.name === m[1])) {
            defaultApiId = m[1]
            break outer
          }
        }
      }
    }
  } catch { /* fallback to first */ }

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
): Promise<number> {
  const data = await gql(creds.endpoint, creds.token, `
    query { result: ${modelApiId}Connection(locales: [${defaultLocale}]) { aggregate { count } } }
  `)
  return data.result?.aggregate?.count ?? 0
}

export async function fetchLocalisationCounts(
  creds: HygraphCredentials,
  modelApiId: string,
  locales: string[],
  total: number,
): Promise<Record<string, number>> {
  try {
    return await countViaWhere(creds, modelApiId, locales)
  } catch {
    return await countViaScan(creds, modelApiId, locales, total)
  }
}

async function countViaWhere(
  creds: HygraphCredentials,
  modelApiId: string,
  locales: string[],
): Promise<Record<string, number>> {
  const aliases = locales
    .map(
      l => `${l}: ${modelApiId}Connection(where: { localizations_some: { locale: ${l} } }) {
        aggregate { count }
      }`,
    )
    .join('\n')

  const data = await gql(creds.endpoint, creds.token, `query { ${aliases} }`)
  const counts: Record<string, number> = {}
  for (const l of locales) counts[l] = data[l]?.aggregate?.count ?? 0
  return counts
}

async function countViaScan(
  creds: HygraphCredentials,
  modelApiId: string,
  locales: string[],
  total: number,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(locales.map(l => [l, 0]))
  const PAGE = 500
  let skip = 0

  while (skip < total) {
    const data = await gql(creds.endpoint, creds.token, `
      query {
        entries: ${modelApiId}(first: ${PAGE}, skip: ${skip}) {
          localizations { locale }
        }
      }
    `)
    const entries: Array<{ localizations: Array<{ locale: string }> }> = data.entries ?? []
    for (const entry of entries) {
      const has = new Set(entry.localizations.map(l => l.locale))
      for (const l of locales) if (has.has(l)) counts[l]++
    }
    if (entries.length < PAGE) break
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
    const fields: Array<{ name: string; type: { name?: string; ofType?: { name?: string } } }> =
      data.__type?.fields ?? []
    for (const c of ['title', 'name', 'headline', 'label', 'slug', 'displayName']) {
      const f = fields.find(x => x.name === c)
      if (f && (f.type.name === 'String' || f.type.ofType?.name === 'String')) return c
    }
  } catch { /* ignore */ }
  return null
}

export async function fetchMissingForLocale(
  creds: HygraphCredentials,
  modelApiId: string,
  modelType: string,
  locale: string,
  defaultLocale: string,
  onProgress?: (n: number) => void,
): Promise<MissingEntry[]> {
  const PAGE = 100
  const missing: MissingEntry[] = []
  let skip = 0
  let hasMore = true
  const projectId = extractProjectId(creds.endpoint)
  const titleField = await fetchTitleField(creds, modelType)

  while (hasMore) {
    try {
      const data = await gql(creds.endpoint, creds.token, `
        query {
          entries: ${modelApiId}(locales: [${defaultLocale}], first: ${PAGE}, skip: ${skip}) {
            id
            ${titleField ?? ''}
            localizations(locales: [${locale}]) { locale }
          }
        }
      `)
      const entries: Array<{
        id: string; localizations: Array<{ locale: string }>; [k: string]: unknown
      }> = data.entries ?? []

      for (const e of entries) {
        if (!e.localizations.some(l => l.locale === locale)) {
          missing.push({
            id: e.id,
            title: titleField ? String(e[titleField] ?? '') || e.id : e.id,
            missingLocales: [locale],
            studioUrl: projectId
              ? `https://app.hygraph.com/${projectId}/master/content/${modelType}/view/${e.id}`
              : '#',
          })
        }
      }
      onProgress?.(skip + entries.length)
      hasMore = entries.length === PAGE
      skip += PAGE
    } catch {
      hasMore = false
    }
  }
  return missing
}

// ─── Hierarchical drill-down ──────────────────────────────────────────────────

export async function fetchEntryList(
  creds: HygraphCredentials,
  modelApiId: string,
  modelType: string,
  locales: HygraphLocale[],
  defaultLocale: string,
  first: number,
  skip: number,
): Promise<{ entries: EntryListItem[]; total: number }> {
  const titleField = await fetchTitleField(creds, modelType)
  const data = await gql(creds.endpoint, creds.token, `
    query {
      entries: ${modelApiId}(locales: [${defaultLocale}], first: ${first}, skip: ${skip}) {
        id
        ${titleField ?? ''}
        localizations { locale }
      }
      total: ${modelApiId}Connection(locales: [${defaultLocale}]) { aggregate { count } }
    }
  `)

  const projectId = extractProjectId(creds.endpoint)
  return {
    entries: ((data.entries ?? []) as Array<Record<string, unknown>>).map(e => {
      const presentLocales = new Set(
        (e.localizations as Array<{ locale: string }>).map(l => l.locale),
      )
      return {
        id: e.id as string,
        title: titleField ? String(e[titleField] ?? '') || (e.id as string) : (e.id as string),
        localePresentMap: Object.fromEntries(locales.map(l => [l.apiId, presentLocales.has(l.apiId)])),
        studioUrl: projectId
          ? `https://app.hygraph.com/${projectId}/master/content/${modelType}/view/${e.id}`
          : '#',
      }
    }),
    total: (data.total as { aggregate: { count: number } } | null)?.aggregate?.count ?? 0,
  }
}

export async function fetchLocalizableFields(
  creds: HygraphCredentials,
  modelType: string,
): Promise<Array<{ name: string; typeName: string; isRichText: boolean }>> {
  // Hygraph exposes exactly the localizable fields via the ${ModelType}Locale type
  const data = await gql(creds.endpoint, creds.token, `
    query {
      localeType: __type(name: "${modelType}Locale") {
        fields { name type { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  `)

  const fields: Array<{ name: string; type: { kind: string; name?: string; ofType?: unknown } }> =
    data.localeType?.fields ?? []

  return fields
    .filter(f => !SYSTEM_FIELDS.has(f.name))
    .map(f => {
      const typeName = unwrapType(f.type) ?? f.type.name ?? 'String'
      return { name: f.name, typeName, isRichText: typeName.includes('RichText') }
    })
}

export async function fetchEntryFieldCoverage(
  creds: HygraphCredentials,
  modelApiId: string,
  modelType: string,
  entryId: string,
  defaultLocale: string,
  targetLocale: string,
): Promise<EntryFieldCoverage> {
  const [localizableFields, titleField] = await Promise.all([
    fetchLocalizableFields(creds, modelType),
    fetchTitleField(creds, modelType),
  ])

  const isSameLocale = defaultLocale === targetLocale
  const localesToFetch = isSameLocale ? [defaultLocale] : [defaultLocale, targetLocale]

  const fieldSelections = localizableFields
    .map(f => (f.isRichText ? `${f.name} { text }` : f.name))
    .join('\n')

  let entry: Record<string, unknown> | null = null

  if (fieldSelections) {
    const data = await gql(creds.endpoint, creds.token, `
      query {
        entries: ${modelApiId}(
          locales: [${localesToFetch.join(', ')}],
          where: { id: "${entryId}" }
        ) {
          id
          ${titleField ?? ''}
          localizations(locales: [${localesToFetch.join(', ')}]) {
            locale
            ${fieldSelections}
          }
        }
      }
    `)
    entry = ((data.entries as Array<Record<string, unknown>>) ?? [])[0] ?? null
  }

  if (!entry) throw new Error('Entry not found')

  function stringify(v: unknown): string | null {
    if (v === null || v === undefined) return null
    if (typeof v === 'object') return (v as { text?: string }).text ?? null
    const s = String(v)
    return s === '' ? null : s
  }

  const locs = (entry.localizations as Array<Record<string, unknown>>) ?? []
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
  if (!locales.length) return []

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
  } catch { /* fall through */ }

  try {
    const PAGE = 500
    const counts: Record<string, { draft: number; published: number }> =
      Object.fromEntries(locales.map(l => [l, { draft: 0, published: 0 }]))
    let skip = 0
    let hasMore = true

    while (hasMore) {
      const data = await gql(creds.endpoint, creds.token, `
        query {
          entries: ${modelApiId}(first: ${PAGE}, skip: ${skip}) {
            id
            localizations(stages: [DRAFT, PUBLISHED]) { locale stage }
          }
        }
      `)
      const entries: Array<{ id: string; localizations: Array<{ locale: string; stage: string }> }> =
        data.entries ?? []

      for (const entry of entries) {
        for (const l of locales) {
          const locs = entry.localizations.filter(loc => loc.locale === l)
          if (locs.some(loc => loc.stage === 'DRAFT'))     counts[l].draft++
          if (locs.some(loc => loc.stage === 'PUBLISHED')) counts[l].published++
        }
      }

      hasMore = entries.length === PAGE
      skip += PAGE
    }

    return locales.map(l => ({
      locale: l,
      published: counts[l].published,
      draftOnly: Math.max(0, counts[l].draft - counts[l].published),
    }))
  } catch { /* fall through */ }

  try {
    const localeFields = locales
      .map((l, i) => `loc${i}: localizations(locales: [${l}]) { locale }`)
      .join('\n')

    async function scanStage(stage: 'DRAFT' | 'PUBLISHED'): Promise<Record<string, number>> {
      const c: Record<string, number> = Object.fromEntries(locales.map(l => [l, 0]))
      const PAGE = 500
      let skip = 0
      let hasMore = true
      while (hasMore) {
        const data = await gql(creds.endpoint, creds.token, `
          query {
            entries: ${modelApiId}(stage: ${stage}, first: ${PAGE}, skip: ${skip}) {
              id
              ${localeFields}
            }
          }
        `)
        const entries: Array<Record<string, unknown>> = data.entries ?? []
        for (const entry of entries) {
          for (let i = 0; i < locales.length; i++) {
            if (((entry[`loc${i}`] as Array<unknown>) ?? []).length > 0) c[locales[i]]++
          }
        }
        hasMore = entries.length === PAGE
        skip += PAGE
      }
      return c
    }

    const [draftCounts, publishedCounts] = await Promise.all([
      scanStage('DRAFT'),
      scanStage('PUBLISHED'),
    ])

    const hasDiff = locales.some(l => (draftCounts[l] ?? 0) !== (publishedCounts[l] ?? 0))
    if (!hasDiff && locales.some(l => (publishedCounts[l] ?? 0) > 0)) return null

    return locales.map(l => ({
      locale: l,
      published: publishedCounts[l] ?? 0,
      draftOnly: Math.max(0, (draftCounts[l] ?? 0) - (publishedCounts[l] ?? 0)),
    }))
  } catch {
    return null
  }
}
