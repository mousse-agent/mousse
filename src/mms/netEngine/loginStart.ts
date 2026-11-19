import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installServiceEntry } from '../../cli/serviceInstall'
import { startupStatus } from '../startup'

/**
 * The startup entry `mousse-cli service install` writes (`mms/startup`): the only one there is (design §10). The
 * networking never writes one of its own and never removes it.
 */
export interface StartupEntry {
  installed(): Promise<boolean>
  install(): Promise<void>
}

/** The startup entry for the installation at `home` (its `MOUSSE_HOME`). */
export function startupEntry(home: string): StartupEntry {
  return {
    installed: async () => (await startupStatus()).installed,
    // `mousse-cli service install`'s own path; the entry names the CLI this daemon runs from.
    install: () => installServiceEntry({ homeDir: home })
  }
}

/**
 * Whether Mousse starts at login for this OS account (the startup entry is installed). An entry that cannot be read
 * counts as not installed. What SSH `profiles` and `prepare` replies carry as `starts_at_login` (§3.4).
 */
export async function startsAtLogin(
  installed: () => Promise<boolean> = async () => (await startupStatus()).installed
): Promise<boolean> {
  try {
    return await installed()
  } catch {
    return false
  }
}

/** What the installation remembers of the question: it was asked and not answered yet, or the answer. */
type Saved = { state: 'asked' } | { state: 'answered'; answer: 'start' | 'not_now'; at: number }

/** Where an installation keeps the answer: beside its profiles, one file for all of them. */
export function loginStartFile(installationHome: string): string {
  return join(installationHome, 'net-engine-login-start.json')
}

/**
 * "Start Mousse at login so your other computers can reach this one?" (design §10). Asked once per installation,
 * when a profile's networking is turned on in a window and the startup entry is not installed. The question stays
 * until it is answered, across restarts; the answer is kept and it is not asked again. "Start at login" installs
 * the existing entry; "Not now" changes nothing.
 */
export class LoginStartQuestion {
  /** The file's contents, once read (`null`: nothing saved). */
  private saved?: Saved | null

  constructor(
    private readonly file: string,
    private readonly entry: StartupEntry
  ) {}

  private read(): Saved | null {
    if (this.saved !== undefined) return this.saved
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved> & { answer?: unknown }
      this.saved =
        value?.state === 'asked'
          ? { state: 'asked' }
          : value?.state === 'answered' && (value.answer === 'start' || value.answer === 'not_now')
            ? { state: 'answered', answer: value.answer, at: Number(value.at) || 0 }
            : null
    } catch {
      this.saved = null
    }
    return this.saved
  }

  private write(saved: Saved): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(saved))
    renameSync(temp, this.file)
    this.saved = saved
  }

  /** Whether the question is waiting for an answer. */
  asking(): boolean {
    return this.read()?.state === 'asked'
  }

  /**
   * A profile's networking was turned on in a window. Asks when nothing was answered yet and the entry is not
   * installed; answers whether the question is waiting now. An entry that cannot be read asks nothing this time.
   */
  async turnedOn(): Promise<boolean> {
    if (this.read()) return this.asking()
    let installed: boolean
    try {
      installed = await this.entry.installed()
    } catch {
      return false
    }
    if (installed || this.read()) return this.asking()
    this.write({ state: 'asked' })
    return true
  }

  /**
   * The answer: `start` installs the startup entry, then remembers it. A failed install throws and leaves the
   * question waiting. An answer with no question waiting changes nothing.
   */
  async answer(start: boolean): Promise<void> {
    if (!this.asking()) return
    if (start) await this.entry.install()
    this.write({ state: 'answered', answer: start ? 'start' : 'not_now', at: Date.now() })
  }
}

const questions = new Map<string, LoginStartQuestion>()

/** The installation's question (one per installation home, shared by its profiles). */
export function loginStartQuestion(installationHome: string): LoginStartQuestion {
  let question = questions.get(installationHome)
  if (!question) {
    question = new LoginStartQuestion(
      loginStartFile(installationHome),
      startupEntry(installationHome)
    )
    questions.set(installationHome, question)
  }
  return question
}
