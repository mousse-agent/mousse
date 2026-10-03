import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { NetError } from '../../../shared/net';
import { BRIDGE_DISPLAY_CHUNK_BYTES, BRIDGE_DISPLAY_MAX_BYTES, displayJson, displayHash, displayBase64, displayKey, validateDisplayPart, validateDisplayEvent } from '../../../shared/bridge';
import type { BridgeDisplayEvent, BridgeDisplayPart } from '../../../shared/bridge';
/** Each yield is an explicit pause. A synchronous event emitter is not backpressure. */
export async function* bridgeDisplayParts(event: BridgeDisplayEvent, signal?: AbortSignal): AsyncGenerator<BridgeDisplayPart> {
    const alive = () => { if (signal?.aborted)
        throw new NetError('cancelled'); };
    alive();
    validateDisplayEvent(event);
    const { update, ...binding } = event;
    if (update.kind === 'event') {
        const part = validateDisplayPart(event);
        await yieldTurn();
        alive();
        yield part;
        return;
    }
    const bytes = displayJson(update.value);
    if (bytes.length > BRIDGE_DISPLAY_MAX_BYTES)
        throw new NetError('too_large');
    if (bytes.length <= BRIDGE_DISPLAY_CHUNK_BYTES) {
        const part = validateDisplayPart(event);
        await yieldTurn();
        alive();
        yield part;
        return;
    }
    const transaction = randomUUID(), sha256 = await displayHash(bytes), chunks = Math.ceil(bytes.length / BRIDGE_DISPLAY_CHUNK_BYTES);
    await yieldTurn();
    alive();
    yield validateDisplayPart({ ...binding, update: { kind: 'snapshot.begin', transaction, totalBytes: bytes.length, chunks, sha256 } });
    for (let index = 0; index < chunks; index++) {
        await yieldTurn();
        alive();
        yield validateDisplayPart({ ...binding, update: { kind: 'snapshot.chunk', transaction, index, data: displayBase64(bytes.subarray(index * BRIDGE_DISPLAY_CHUNK_BYTES, (index + 1) * BRIDGE_DISPLAY_CHUNK_BYTES)) } });
    }
    await yieldTurn();
    alive();
    yield validateDisplayPart({ ...binding, update: { kind: 'snapshot.end', transaction, sha256 } });
}
export interface BridgeDisplaySink {
    /** Resolves only after the actual connection writer/drain; no synchronous emitter fallback. */
    emit(part: BridgeDisplayPart, signal: AbortSignal): Promise<void>;
    error?(code: string): void;
}
/** Bounded asynchronous queue over a cancellation-aware connection writer. */
export class BridgeDisplayEmitter {
    private tail: Promise<void> = Promise.resolve();
    private queued = 0;
    private bytes = 0;
    private readonly abort = new AbortController();
    private readonly published = new Map<string, {
        stream: string;
        epoch: number;
        seq: number;
        hash: string;
    }>();
    constructor(private readonly sink: BridgeDisplaySink, private readonly options: {
        maxQueuedEvents?: number;
        maxQueuedBytes?: number;
    } = {}) {
        for (const [key, maximum] of [['maxQueuedEvents', 64], ['maxQueuedBytes', 64 * 1024 * 1024]] as const) {
            const value = options[key];
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum))
                throw new NetError('bad_request');
        }
    }
    enqueue(event: BridgeDisplayEvent): Promise<void> {
        if (this.abort.signal.aborted)
            return Promise.reject(new NetError('cancelled'));
        let bytes: Uint8Array;
        try {
            validateDisplayEvent(event);
            bytes = displayJson(event.update);
            if (bytes.length > BRIDGE_DISPLAY_MAX_BYTES + 1024)
                throw new NetError('too_large');
        }
        catch (error) {
            return Promise.reject(error);
        }
        if (this.queued >= (this.options.maxQueuedEvents ?? 64) || this.bytes + bytes.length > (this.options.maxQueuedBytes ?? 64 * 1024 * 1024))
            return Promise.reject(new NetError('too_large'));
        // Freeze before the queue yields: callers cannot change a queued generation.
        const frozen = { ...event, ref: { ...event.ref }, update: JSON.parse(new TextDecoder().decode(bytes)) } as BridgeDisplayEvent;
        this.queued++;
        this.bytes += bytes.length;
        const pending = this.tail.then(async () => {
            if (this.abort.signal.aborted)
                throw new NetError('cancelled');
            const key = displayKey(frozen.ref), hash = await displayHash(bytes), prior = this.published.get(key);
            if (prior && frozen.stream !== prior.stream)
                throw new NetError('conflict');
            if (prior && frozen.epoch === prior.epoch && frozen.seq === prior.seq) {
                if (hash !== prior.hash)
                    throw new NetError('conflict');
            }
            if (!this.published.has(key) && this.published.size >= 64)
                throw new NetError('too_large');
            for await (const part of bridgeDisplayParts(frozen, this.abort.signal))
                await this.write(part);
            if (!prior || frozen.epoch > prior.epoch || frozen.epoch === prior.epoch && frozen.seq >= prior.seq)
                this.published.set(key, { stream: frozen.stream, epoch: frozen.epoch, seq: frozen.seq, hash });
        }).finally(() => { this.queued--; this.bytes -= bytes.length; });
        this.tail = pending.catch(error => { try {
            this.sink.error?.(error instanceof NetError ? error.code : 'internal');
        }
        catch { /* Independent local diagnostics. */ } });
        return pending;
    }
    private write(part: BridgeDisplayPart): Promise<void> {
        const signal = this.abort.signal;
        if (signal.aborted)
            return Promise.reject(new NetError('cancelled'));
        return new Promise<void>((resolve, reject) => { const abort = () => { signal.removeEventListener('abort', abort); reject(new NetError('cancelled')); }; signal.addEventListener('abort', abort, { once: true }); Promise.resolve().then(() => {const pending: unknown = this.sink.emit(part, signal); if (typeof pending !== 'object' || pending === null || !('then' in pending) || typeof pending.then !== 'function') throw new NetError('bad_request', 'Bridge display requires an asynchronous writer.'); return pending as Promise<void>}).then(() => { signal.removeEventListener('abort', abort); resolve(); }, error => { signal.removeEventListener('abort', abort); reject(error); }); });
    }
    close(): void { this.abort.abort(); }
    drain(): Promise<void> { return this.tail; }
    usage(): {
        events: number;
        bytes: number;
    } { return { events: this.queued, bytes: this.bytes }; }
}
