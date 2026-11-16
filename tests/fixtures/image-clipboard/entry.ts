import { copyImage } from '../../../src/renderer/lib/copyImage'

/** A 1 by 1 red GIF. */
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIABAP8AAP///ywAAAAAAQABAAACAkQBADs='

/** A red picture of the given size and format, drawn here. */
function canvasPicture(width: number, height: number, type: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')!
  context.fillStyle = '#ff0000'
  context.fillRect(0, 0, width, height)
  return canvas.toDataURL(type)
}

async function blobOf(url: string): Promise<string> {
  return URL.createObjectURL(await (await fetch(url)).blob())
}

/** Every kind of address and format a thread or bot chat shows a picture by, with its own size. */
async function pictures(): Promise<Record<string, { url: string; width: number; height: number }>> {
  const png = canvasPicture(5, 3, 'image/png')
  return {
    'png data:': { url: png, width: 5, height: 3 },
    'png blob:': { url: await blobOf(png), width: 5, height: 3 },
    'png app protocol': { url: 'mousse-test-asset://pictures/red.png', width: 5, height: 3 },
    'gif data:': { url: GIF, width: 1, height: 1 },
    'gif blob:': { url: await blobOf(GIF), width: 1, height: 1 },
    'webp data:': { url: canvasPicture(4, 2, 'image/webp'), width: 4, height: 2 },
    // A thumbnail or attachment the person clicks to open is a picture inside a button.
    'png in a button': { url: png, width: 5, height: 3 }
  }
}

declare global { interface Window { qa: unknown } }

window.qa = {
  /** Shows every picture at 60 by 40, whatever its own size, and says where each one's middle is. */
  async show() {
    const placed: Record<string, { url: string; width: number; height: number; x: number; y: number }> = {}
    for (const [name, picture] of Object.entries(await pictures())) {
      const image = document.createElement('img')
      image.style.cssText = 'display:block;width:60px;height:40px;margin:12px'
      image.alt = name
      image.src = picture.url
      if (name.endsWith('in a button')) {
        const button = document.createElement('button')
        button.type = 'button'
        button.append(image)
        document.body.append(button)
      } else document.body.append(image)
      await image.decode()
      const box = image.getBoundingClientRect()
      placed[name] = { ...picture, x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
    }
    return placed
  },
  /** What a bot picture's own Copy image does. */
  copy: (url: string) => copyImage(url).then(() => 'copied', (error: Error) => `failed: ${error.message}`)
}
