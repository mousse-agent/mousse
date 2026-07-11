import { randomInt } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ChannelConfig, ChannelPlatform, PairingRequest } from '../../shared/types'
import { getChannelsPairingDir } from '../data/paths'
import type { InboundChannelMessage } from './types'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const CODE_TTL_MS = 60 * 60 * 1000
const RATE_LIMIT_MS = 10 * 60 * 1000
const MAX_PENDING_PER_PLATFORM = 3

interface PendingEntry {
  code: string
  userId: string
  userName?: string
  createdAt: string
  expiresAt: string
}

interface RateLimitEntry {
  lastRequestAt: string
}

function ensurePairingDir(): void {
  mkdirSync(getChannelsPairingDir(), { recursive: true })
}

function pairingPath(platform: ChannelPlatform, kind: 'pending' | 'approved'): string {
  return join(getChannelsPairingDir(), `${platform}-${kind}.json`)
}

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function saveJson(path: string, data: unknown): void {
  ensurePairingDir()
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}

function generateCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)]!
  }
  return code
}

export class ChannelAuth {
  isAuthorized(config: ChannelConfig, message: InboundChannelMessage): boolean {
    const platformConfig = config.platforms[message.platform]
    if (platformConfig.allowAllUsers) return true

    const allowed = platformConfig.allowedUserIds ?? []
    if (allowed.includes(message.userId)) return true

    const approved = loadJson<Record<string, { userName?: string; approvedAt: string }>>(
      pairingPath(message.platform, 'approved'),
      {}
    )
    return message.userId in approved
  }

  listPendingRequests(): PairingRequest[] {
    const platforms: ChannelPlatform[] = ['telegram', 'discord', 'webhook']
    const now = Date.now()
    const results: PairingRequest[] = []

    for (const platform of platforms) {
      const pending = loadJson<Record<string, PendingEntry>>(
        pairingPath(platform, 'pending'),
        {}
      )
      for (const entry of Object.values(pending)) {
        if (new Date(entry.expiresAt).getTime() <= now) continue
        results.push({
          code: entry.code,
          platform,
          userId: entry.userId,
          userName: entry.userName,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt
        })
      }
    }

    return results.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }

  createPairingRequest(message: InboundChannelMessage): PairingRequest | null {
    const rateLimits = loadJson<Record<string, RateLimitEntry>>(
      join(getChannelsPairingDir(), '_rate_limits.json'),
      {}
    )
    const rateKey = `${message.platform}:${message.userId}`
    const last = rateLimits[rateKey]?.lastRequestAt
    if (last && Date.now() - new Date(last).getTime() < RATE_LIMIT_MS) {
      return null
    }

    const pendingPath = pairingPath(message.platform, 'pending')
    const pending = loadJson<Record<string, PendingEntry>>(pendingPath, {})
    const now = Date.now()
    const active = Object.values(pending).filter(
      (entry) => new Date(entry.expiresAt).getTime() > now
    )
    if (active.length >= MAX_PENDING_PER_PLATFORM) {
      return null
    }

    const code = generateCode()
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(now + CODE_TTL_MS).toISOString()
    pending[code] = {
      code,
      userId: message.userId,
      userName: message.userName,
      createdAt,
      expiresAt
    }
    saveJson(pendingPath, pending)

    rateLimits[rateKey] = { lastRequestAt: createdAt }
    saveJson(join(getChannelsPairingDir(), '_rate_limits.json'), rateLimits)

    return {
      code,
      platform: message.platform,
      userId: message.userId,
      userName: message.userName,
      createdAt,
      expiresAt
    }
  }

  approvePairing(code: string): boolean {
    const normalized = code.trim().toUpperCase()
    for (const platform of ['telegram', 'discord', 'webhook'] as ChannelPlatform[]) {
      const pendingPath = pairingPath(platform, 'pending')
      const pending = loadJson<Record<string, PendingEntry>>(pendingPath, {})
      const entry = pending[normalized]
      if (!entry) continue
      if (new Date(entry.expiresAt).getTime() <= Date.now()) {
        delete pending[normalized]
        saveJson(pendingPath, pending)
        return false
      }

      delete pending[normalized]
      saveJson(pendingPath, pending)

      const approvedPath = pairingPath(platform, 'approved')
      const approved = loadJson<Record<string, { userName?: string; approvedAt: string }>>(
        approvedPath,
        {}
      )
      approved[entry.userId] = {
        userName: entry.userName,
        approvedAt: new Date().toISOString()
      }
      saveJson(approvedPath, approved)
      return true
    }
    return false
  }

  rejectPairing(code: string): boolean {
    const normalized = code.trim().toUpperCase()
    for (const platform of ['telegram', 'discord', 'webhook'] as ChannelPlatform[]) {
      const pendingPath = pairingPath(platform, 'pending')
      const pending = loadJson<Record<string, PendingEntry>>(pendingPath, {})
      if (!(normalized in pending)) continue
      delete pending[normalized]
      saveJson(pendingPath, pending)
      return true
    }
    return false
  }

  getApprovedUserIds(platform: ChannelPlatform): string[] {
    const approved = loadJson<Record<string, { approvedAt: string }>>(
      pairingPath(platform, 'approved'),
      {}
    )
    return Object.keys(approved)
  }
}
