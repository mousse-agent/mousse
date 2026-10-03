import { BRIDGE_THREAD_EVENT_TYPES, NetError, isId } from '../net';
import type { StreamId } from '../net';
import type { BridgeEntityRef } from './types';
export const BRIDGE_DISPLAY_CHUNK_BYTES = 32 * 1024;
export const BRIDGE_DISPLAY_MAX_BYTES = 32 * 1024 * 1024;
export const BRIDGE_DISPLAY_FRAME_BYTES = 64 * 1024;
export const BRIDGE_DISPLAY_EVENT_TYPES = BRIDGE_THREAD_EVENT_TYPES;
export interface BridgeDisplayPosition {
    stream: StreamId;
    epoch: number;
    seq: number;
}
export type BridgeDisplayUpdate = {
    kind: 'snapshot';
    value: unknown;
} | {
    kind: 'event';
    type: string;
    data: unknown;
};
export interface BridgeDisplayEvent extends BridgeDisplayPosition {
    ref: BridgeEntityRef;
    update: BridgeDisplayUpdate;
}
export type BridgeDisplayPart = BridgeDisplayPosition & {
    ref: BridgeEntityRef;
    update: BridgeDisplayUpdate | {
        kind: 'snapshot.begin';
        transaction: string;
        totalBytes: number;
        chunks: number;
        sha256: string;
    } | {
        kind: 'snapshot.chunk';
        transaction: string;
        index: number;
        data: string;
    } | {
        kind: 'snapshot.end';
        transaction: string;
        sha256: string;
    };
};
const bad = (): never => { throw new NetError('bad_request'); };
const large = (): never => { throw new NetError('too_large'); };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Browser-portable compact JSON, with the same numeric/structure limits as Net JSON. */
export function displayJson(value: unknown): Uint8Array {
    let nodes = 0;
    const serialize = (item: unknown, depth: number): string => {
        if (depth > 32 || ++nodes > 16384)
            return large();
        if (item === null || typeof item === 'boolean')
            return JSON.stringify(item);
        if (typeof item === 'number') {
            if (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))
                return bad();
            return JSON.stringify(item);
        }
        if (typeof item === 'string') {
            if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item))
                return bad();
            return JSON.stringify(item);
        }
        if (Array.isArray(item)) {
            for (let i = 0; i < item.length; i++)
                if (!Object.hasOwn(item, i))
                    return bad();
            return `[${item.map(value => serialize(value, depth + 1)).join(',')}]`;
        }
        if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item)))
            return `{${Object.keys(item).sort().map(key => `${serialize(key, depth + 1)}:${serialize((item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
        return bad();
    };
    return encoder.encode(serialize(value, 0));
}
export function displayBase64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unbase64(value: unknown, maximum: number): Uint8Array {
    if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value))
        return bad();
    let source: string;
    try {
        source = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    }
    catch {
        return bad();
    }
    const bytes = Uint8Array.from(source, char => char.charCodeAt(0));
    if (bytes.length > maximum || displayBase64(bytes) !== value)
        return bad();
    return bytes;
}
export async function displayHash(bytes: Uint8Array): Promise<string> { return displayBase64(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource))); }
function fields(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.slice().sort().join(','))
        return bad();
    return value as Record<string, unknown>;
}
export function displayKey(ref: BridgeEntityRef): string { return JSON.stringify([ref.nodeId, ref.entityId]); }
export function validateDisplayPart(value: unknown): BridgeDisplayPart {
    const row = fields(value, ['ref', 'stream', 'epoch', 'seq', 'update']), ref = fields(row.ref, ['nodeId', 'entityId']);
    if (!isId('node', ref.nodeId) || typeof ref.entityId !== 'string' || !ref.entityId.length || ref.entityId.length > 256 || !isId('stream', row.stream) || !Number.isSafeInteger(row.epoch) || Number(row.epoch) < 1 || !Number.isSafeInteger(row.seq) || Number(row.seq) < 1)
        return bad();
    const update = row.update as Record<string, unknown>;
    if (!update || typeof update !== 'object')
        return bad();
    if (update.kind === 'snapshot') {
        fields(update, ['kind', 'value']);
        if (displayJson(update.value).length > BRIDGE_DISPLAY_CHUNK_BYTES)
            return large();
    }
    else if (update.kind === 'event') {
        fields(update, ['kind', 'type', 'data']);
        if (!BRIDGE_DISPLAY_EVENT_TYPES.includes(update.type as never))
            return bad();
    }
    else if (update.kind === 'snapshot.begin') {
        fields(update, ['kind', 'transaction', 'totalBytes', 'chunks', 'sha256']);
        if (typeof update.transaction !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(update.transaction) || !Number.isSafeInteger(update.totalBytes) || Number(update.totalBytes) < 1 || Number(update.totalBytes) > BRIDGE_DISPLAY_MAX_BYTES || !Number.isSafeInteger(update.chunks) || Number(update.chunks) !== Math.ceil(Number(update.totalBytes) / BRIDGE_DISPLAY_CHUNK_BYTES) || unbase64(update.sha256, 32).length !== 32)
            return bad();
    }
    else if (update.kind === 'snapshot.chunk') {
        fields(update, ['kind', 'transaction', 'index', 'data']);
        if (typeof update.transaction !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(update.transaction) || !Number.isSafeInteger(update.index) || Number(update.index) < 0)
            return bad();
        unbase64(update.data, BRIDGE_DISPLAY_CHUNK_BYTES);
    }
    else if (update.kind === 'snapshot.end') {
        fields(update, ['kind', 'transaction', 'sha256']);
        if (typeof update.transaction !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(update.transaction) || unbase64(update.sha256, 32).length !== 32)
            return bad();
    }
    else
        return bad();
    if (displayJson(row).length > BRIDGE_DISPLAY_FRAME_BYTES)
        return large();
    return row as unknown as BridgeDisplayPart;
}
export function validateDisplayEvent(value: unknown): BridgeDisplayEvent {
    const row = fields(value, ['ref', 'stream', 'epoch', 'seq', 'update']), ref = fields(row.ref, ['nodeId', 'entityId']), update = row.update as Record<string, unknown>;
    if (!isId('node', ref.nodeId) || typeof ref.entityId !== 'string' || !ref.entityId.length || ref.entityId.length > 256 || !isId('stream', row.stream) || !Number.isSafeInteger(row.epoch) || Number(row.epoch) < 1 || !Number.isSafeInteger(row.seq) || Number(row.seq) < 1 || !update || typeof update !== 'object')
        return bad();
    if (update.kind === 'snapshot') {
        fields(update, ['kind', 'value']);
        if (displayJson(update.value).length > BRIDGE_DISPLAY_MAX_BYTES)
            return large();
    }
    else if (update.kind === 'event') {
        fields(update, ['kind', 'type', 'data']);
        if (!BRIDGE_DISPLAY_EVENT_TYPES.includes(update.type as never) || displayJson(row).length > BRIDGE_DISPLAY_FRAME_BYTES)
            return bad();
    }
    else
        return bad();
    return row as unknown as BridgeDisplayEvent;
}
interface Pending {
    position: BridgeDisplayPosition;
    ref: BridgeEntityRef;
    transaction: string;
    bytes: number;
    chunks: number;
    hash: string;
    parts: Uint8Array[];
    received: number;
}
interface Committed {
    position: BridgeDisplayPosition;
    hash: string;
}
export interface BridgeDisplayDecoderOptions {
    ref?: BridgeEntityRef;
    maxConcurrent?: number;
    maxAggregateBytes?: number;
    maxReferences?: number;
    maxQueuedFrames?: number;
    maxQueuedBytes?: number;
}
/** Partial, corrupt, cancelled and stale generations never replace visible display state. */
export class BridgeDisplayDecoder {
    private readonly pending = new Map<string, Pending>();
    private readonly committed = new Map<string, Committed>();
    private tail: Promise<unknown> = Promise.resolve();
    private queued = 0;
    private queuedBytes = 0;
    private aggregate = 0;
    private revision = 0;
    private closed = false;
    constructor(private readonly options: BridgeDisplayDecoderOptions = {}) {
        for (const [key, hard] of [['maxConcurrent', 8], ['maxAggregateBytes', 64 * 1024 * 1024], ['maxReferences', 64], ['maxQueuedFrames', 64], ['maxQueuedBytes', 1024 * 1024]] as const) {
            const value = options[key];
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > hard))
                return bad();
        }
    }
    accept(value: unknown, signal?: AbortSignal): Promise<BridgeDisplayEvent | undefined> {
        if (this.closed || signal?.aborted)
            return Promise.reject(new NetError('cancelled'));
        let part: BridgeDisplayPart, bytes: number;
        try {
            part = validateDisplayPart(value);
            if (this.options.ref && displayKey(part.ref) !== displayKey(this.options.ref))
                return Promise.reject(new NetError('forbidden'));
            const encoded = displayJson(part);
            bytes = encoded.length;
            part = JSON.parse(decoder.decode(encoded)) as BridgeDisplayPart;
        }
        catch (error) {
            this.reset();
            return Promise.reject(error);
        }
        if (this.queued >= (this.options.maxQueuedFrames ?? 64) || this.queuedBytes + bytes > (this.options.maxQueuedBytes ?? 1024 * 1024)) {
            this.reset();
            return Promise.reject(new NetError('too_large'));
        }
        const revision = this.revision;
        this.queued++;
        this.queuedBytes += bytes;
        const promise = this.tail.then(async () => { if (this.closed || revision !== this.revision || signal?.aborted)
            throw new NetError('cancelled'); try {
            return await this.apply(part, signal, revision);
        }
        catch (error) {
            if (revision === this.revision)
                this.reset();
            throw error;
        } }).finally(() => { this.queued--; this.queuedBytes -= bytes; });
        this.tail = promise.catch(() => { });
        return promise;
    }
    private position(part: BridgeDisplayPart): BridgeDisplayPosition { return { stream: part.stream, epoch: part.epoch, seq: part.seq }; }
    private checkPosition(key: string, position: BridgeDisplayPosition): void {
        const prior = this.committed.get(key);
        if (prior && prior.position.stream !== position.stream)
            throw new NetError('conflict');
        if (!prior && this.committed.size + this.pending.size >= (this.options.maxReferences ?? 64))
            return large();
    }
    private finish(key: string, event: BridgeDisplayEvent, hash: string): BridgeDisplayEvent | undefined {
        this.checkPosition(key, this.position(event));
        const prior = this.committed.get(key);
        if (prior && (event.epoch < prior.position.epoch || event.epoch === prior.position.epoch && event.seq < prior.position.seq))
            return;
        if (prior && prior.position.epoch === event.epoch && prior.position.seq === event.seq) {
            if (prior.hash !== hash)
                throw new NetError('conflict');
            return;
        }
        this.committed.set(key, { position: this.position(event), hash });
        return event;
    }
    private async apply(part: BridgeDisplayPart, signal: AbortSignal | undefined, revision: number): Promise<BridgeDisplayEvent | undefined> {
        const key = displayKey(part.ref), position = this.position(part), update = part.update;
        if (update.kind === 'snapshot' || update.kind === 'event') {
            if (this.pending.has(key))
                return bad();
            this.checkPosition(key, position);
            const hash = await displayHash(displayJson(update));
            if (this.closed || revision !== this.revision || signal?.aborted)
                throw new NetError('cancelled');
            return this.finish(key, part as BridgeDisplayEvent, hash);
        }
        if (update.kind === 'snapshot.begin') {
            this.checkPosition(key, position);
            if (this.pending.has(key))
                throw new NetError('conflict');
            if (this.pending.size >= (this.options.maxConcurrent ?? 8) || this.aggregate + update.totalBytes > (this.options.maxAggregateBytes ?? 64 * 1024 * 1024))
                return large();
            this.aggregate += update.totalBytes;
            this.pending.set(key, { position, ref: part.ref, transaction: update.transaction, bytes: update.totalBytes, chunks: update.chunks, hash: update.sha256, parts: [], received: 0 });
            return;
        }
        const pending = this.pending.get(key);
        if (!pending || JSON.stringify(pending.position) !== JSON.stringify(position) || pending.transaction !== update.transaction)
            return bad();
        if (update.kind === 'snapshot.chunk') {
            if (update.index !== pending.parts.length || pending.parts.length >= pending.chunks)
                return bad();
            const bytes = unbase64(update.data, BRIDGE_DISPLAY_CHUNK_BYTES), expected = Math.min(BRIDGE_DISPLAY_CHUNK_BYTES, pending.bytes - pending.received);
            if (bytes.length !== expected)
                return bad();
            pending.parts.push(bytes);
            pending.received += bytes.length;
            return;
        }
        if (update.sha256 !== pending.hash || pending.received !== pending.bytes || pending.parts.length !== pending.chunks)
            return bad();
        const bytes = new Uint8Array(pending.bytes);
        let offset = 0;
        for (const chunk of pending.parts) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        if (await displayHash(bytes) !== pending.hash)
            return bad();
        if (this.closed || revision !== this.revision || signal?.aborted)
            throw new NetError('cancelled');
        let value: unknown;
        try {
            value = JSON.parse(decoder.decode(bytes));
        }
        catch {
            return bad();
        }
        const canonical = displayJson(value);
        if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index]))
            return bad();
        this.pending.delete(key);
        this.aggregate -= pending.bytes;
        // Small and chunked snapshots use the same digest domain for duplicate detection.
        const event: BridgeDisplayEvent = { ref: part.ref, ...position, update: { kind: 'snapshot', value } }, hash = await displayHash(displayJson(event.update));
        if (this.closed || revision !== this.revision || signal?.aborted)
            throw new NetError('cancelled');
        return this.finish(key, event, hash);
    }
    reset(): void { this.revision++; this.pending.clear(); this.aggregate = 0; }
    close(): void { this.closed = true; this.reset(); }
    drain(): Promise<void> { return this.tail.then(() => { }); }
    usage(): {
        transactions: number;
        bytes: number;
        queuedFrames: number;
        queuedBytes: number;
    } { return { transactions: this.pending.size, bytes: this.aggregate, queuedFrames: this.queued, queuedBytes: this.queuedBytes }; }
}
