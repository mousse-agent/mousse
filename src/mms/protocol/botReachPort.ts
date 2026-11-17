import type { BotDeviceChoice } from '../../shared/bots/personal/deviceAccess'

/**
 * Which of the owner's other devices reach which personal bot on this computer (`docs/bots.md`, Which devices reach a
 * bot): the device's own switch (Settings, Devices) and the bot's Devices choice (About), both kept and read here. Bridge
 * installs it on the profile's services; everything that shows a bot to another device asks it.
 */
export interface BotReachPort {
  /** Whether `node` may reach `botId`: its switch for bots here is on, and the bot's choice includes it. */
  canReach(botId: string, node: string): boolean
  /** The device's own switch for bots here (Settings, Devices). */
  deviceOn(node: string): boolean
  /**
   * Whether every device of the account reaches `botId`: what a stream every device may read (the phones' shared lists,
   * a thread's shared display stream) may say about it.
   */
  everyone(botId: string): boolean
  /**
   * Which bots `reader` may not see named (with no reader, what a stream every device may read may not name), or
   * undefined when none is held back, so a large result needs no looking at.
   */
  hiddenFor(reader?: string): ((botId: string) => boolean) | undefined
  /** The owner's other devices on the account, named as Devices names them, for About's Devices row. */
  devices(): Promise<BotDeviceChoice[]>
  /** Called after a bot's choice, a device's switch or the devices on the account change. */
  onChange(listener: () => void): () => void
}
