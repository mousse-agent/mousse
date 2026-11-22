// Every stylesheet under the renderer, compiled by Tailwind the way the renderer build does it: the app's own entry
// sheets and the ones its components import.
import.meta.glob('../../../src/renderer/**/*.css', { eager: true })
