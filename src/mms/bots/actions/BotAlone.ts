/** Exact top-level destinations declared by the tool; content never supplies authority. */
export function actionPlace(schema: unknown, args: Record<string, unknown>): Record<string, unknown> | undefined {
  const names = new Set('folder folderid parent parentid path dir directory channel channelid repo repository owner project projectid calendar calendarid list listid board to recipient recipients email space spaceid database databaseid drive driveid'.split(' '))
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties
  const entries = Object.keys(properties ?? {}).filter(key => names.has(key.toLowerCase().replace(/[_-]/g, '')) && Object.hasOwn(args, key)).map(key => [key, args[key]])
  return entries.length ? Object.fromEntries(entries) : undefined
}
