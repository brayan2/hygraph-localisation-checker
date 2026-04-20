import type { HygraphCredentials, HygraphLocale, HygraphModel, MissingEntry } from '@/types'

async function gql(endpoint: string, token: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`Hygraph API error: ${res.status} ${res.statusText}`)
  }

  const json = await res.json()
  if (json.errors?.length) {
    throw new Error(json.errors[0].message)
  }
  return json.data
}

// Unwrap NON_NULL / LIST wrappers to get the named type
function unwrapType(typeRef: { kind: string; name?: string; ofType?: unknown }): string | null {
  if (!typeRef) return null
  if (typeRef.name) return typeRef.name
  if (typeRef.ofType) return unwrapType(typeRef.ofType as { kind: string; name?: string; ofType?: unknown })
  return null
}

export async function validateCredentials(creds: HygraphCredentials): Promise<void> {
  await gql(creds.endpoint, creds.token, `{ __typename }`)
}

export async function fetchLocales(creds: HygraphCredentials): Promise<HygraphLocale[]> {
  // Hygraph's locale enum is always called "Locale"
  const data = await gql(creds.endpoint, creds.token, `
    query GetLocales {
      __type(name: "Locale") {
        enumValues {
          name
        }
      }
    }
  `)

  const values: Array<{ name: string }> = data?.__type?.enumValues ?? []
  if (values.length === 0) {
    throw new Error('No locales found. Make sure your project has localisation enabled.')
  }

  return values.map((v, i) => ({
    id: v.name,
    apiId: v.name,
    displayName: v.name.replace(/_/g, '-'),
    isDefault: i === 0,
  }))
}

export async function fetchModels(creds: HygraphCredentials): Promise<HygraphModel[]> {
  // Introspect: find all types + all Query fields in one request
  const data = await gql(creds.endpoint, creds.token, `
    query IntrospectSchema {
      __schema {
        types {
          name
          kind
          fields {
            name
          }
        }
        queryType {
          fields {
            name
            type {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
      }
    }
  `)

  // Build a set of type names that have a 'localizations' field
  const localizedTypes = new Set<string>()
  for (const type of data.__schema.types as Array<{ name: string; kind: string; fields: Array<{ name: string }> | null }>) {
    if (
      type.kind === 'OBJECT' &&
      !type.name.startsWith('__') &&
      type.fields?.some((f) => f.name === 'localizations')
    ) {
      localizedTypes.add(type.name)
    }
  }

  // Find plural query fields (list return type) whose underlying type is localised
  const models: HygraphModel[] = []
  const seen = new Set<string>()

  for (const field of data.__schema.queryType.fields as Array<{
    name: string
    type: { kind: string; name?: string; ofType?: unknown }
  }>) {
    // Skip internal, connection, version, aggregate fields
    if (
      field.name.startsWith('_') ||
      field.name.endsWith('Connection') ||
      field.name.endsWith('Version') ||
      field.name.endsWith('Versions') ||
      field.name === 'node'
    ) continue

    const typeName = unwrapType(field.type)
    if (typeName && localizedTypes.has(typeName) && !seen.has(typeName)) {
      seen.add(typeName)
      models.push({
        id: typeName,
        apiId: field.name,            // exact plural query name e.g. "blogPosts"
        displayName: typeName.replace(/([A-Z])/g, ' $1').trim(),
        isLocalized: true,
      })
    }
  }

  return models
}

// Find a human-readable title field on a model type via introspection
async function fetchTitleField(creds: HygraphCredentials, modelType: string): Promise<string | null> {
  try {
    const data = await gql(creds.endpoint, creds.token, `
      query GetModelFields {
        __type(name: "${modelType}") {
          fields {
            name
            type { kind name ofType { kind name } }
          }
        }
      }
    `)
    const fields: Array<{ name: string; type: { kind: string; name?: string; ofType?: { name?: string } } }> =
      data.__type?.fields ?? []

    // Prefer common title-like field names that return a scalar
    const candidates = ['title', 'name', 'headline', 'label', 'slug', 'displayName']
    for (const candidate of candidates) {
      const found = fields.find((f) => f.name === candidate)
      if (found) {
        const typeName = found.type.name ?? found.type.ofType?.name
        if (typeName === 'String' || typeName === 'ID') return candidate
      }
    }
  } catch {
    // Introspection failed — fall back to id only
  }
  return null
}

export async function fetchTotalCount(
  creds: HygraphCredentials,
  modelApiId: string,
): Promise<number> {
  const query = `
    query TotalCount {
      result: ${modelApiId}Connection {
        aggregate { count }
      }
    }
  `
  const data = await gql(creds.endpoint, creds.token, query)
  return data.result?.aggregate?.count ?? 0
}

export async function fetchLocalisationCounts(
  creds: HygraphCredentials,
  modelApiId: string,
  locales: string[],
): Promise<Record<string, number>> {
  // Build aliases for each locale — NO unused variables
  const localeAliases = locales
    .map(
      (locale) =>
        `${locale}: ${modelApiId}Connection(
          locales: [${locale}]
          where: { localizations_some: { locale: ${locale} } }
        ) {
          aggregate { count }
        }`,
    )
    .join('\n      ')

  const query = `
    query CountByLocale {
      ${localeAliases}
    }
  `

  const data = await gql(creds.endpoint, creds.token, query)
  const counts: Record<string, number> = {}
  for (const locale of locales) {
    counts[locale] = data[locale]?.aggregate?.count ?? 0
  }
  return counts
}

export async function fetchMissingForLocale(
  creds: HygraphCredentials,
  modelApiId: string,
  modelType: string,
  locale: string,
  defaultLocale: string,
  onProgress?: (fetched: number) => void,
): Promise<MissingEntry[]> {
  const PAGE_SIZE = 100
  const missing: MissingEntry[] = []
  let skip = 0
  let hasMore = true

  const projectId = extractProjectId(creds.endpoint)
  const titleField = await fetchTitleField(creds, modelType)

  while (hasMore) {
    // Query entries in the default locale, fetching their localizations list
    const query = `
      query FetchEntries {
        entries: ${modelApiId}(
          locales: [${defaultLocale}]
          first: ${PAGE_SIZE}
          skip: ${skip}
        ) {
          id
          ${titleField ? titleField : ''}
          localizations(locales: [${locale}]) {
            locale
          }
        }
      }
    `

    try {
      const data = await gql(creds.endpoint, creds.token, query)
      const entries: Array<{
        id: string
        [key: string]: unknown
        localizations: Array<{ locale: string }>
      }> = data.entries ?? []

      for (const entry of entries) {
        const hasLocale = entry.localizations.some((l) => l.locale === locale)
        if (!hasLocale) {
          const title = titleField ? String(entry[titleField] ?? '') : ''
          missing.push({
            id: entry.id,
            title: title || entry.id,
            missingLocales: [locale],
            studioUrl: projectId
              ? `https://app.hygraph.com/${projectId}/master/content/${modelType}/view/${entry.id}`
              : '#',
          })
        }
      }

      onProgress?.(skip + entries.length)
      hasMore = entries.length === PAGE_SIZE
      skip += PAGE_SIZE
    } catch {
      // If a page fails, stop — don't crash the whole drill-down
      hasMore = false
    }
  }

  return missing
}

function extractProjectId(endpoint: string): string {
  // Matches project IDs in Hygraph endpoints: /content/{projectId}/master
  const match = endpoint.match(/\/content\/([a-zA-Z0-9]+)\//)
  return match?.[1] ?? ''
}
