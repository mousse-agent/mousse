import { afterAll, beforeEach } from 'vitest'
import { createIsolatedMousseHome } from './isolatedMousseHome'

// setupFiles run before test-module imports, so even top-level default service
// construction cannot accidentally open the developer's credential store.
const isolation = createIsolatedMousseHome(process.env)
beforeEach(() => isolation.ensureDefault())
afterAll(() => isolation.cleanup())
