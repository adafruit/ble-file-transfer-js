// A fake Web Bluetooth device wired to the FakeDevice model.
//
// The transport is where the interesting variable lives: PacketBuffer coalesces
// consecutive device writes into notifications, and how many it manages to
// coalesce depends on radio timing. `grouping` sweeps that.

import {FakeDevice, FakeFilesystem} from "./fake-device.mjs";

function toBytes(value) {
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

// Group device writes into notifications. A single write never spans two
// notifications, which is the one guarantee PacketBuffer does make.
export function groupWrites(writes, maxPacketSize, decide) {
    const packets = [];
    let pending = [];
    let pendingSize = 0;
    const flush = () => {
        if (pendingSize === 0) {
            return;
        }
        const packet = new Uint8Array(pendingSize);
        let o = 0;
        for (const w of pending) {
            packet.set(w, o);
            o += w.byteLength;
        }
        packets.push(packet);
        pending = [];
        pendingSize = 0;
    };
    for (const w of writes) {
        if (pendingSize + w.byteLength > maxPacketSize) {
            flush();
        }
        pending.push(w);
        pendingSize += w.byteLength;
        if (decide()) {
            flush();
        }
    }
    flush();
    return packets;
}

export const GROUPINGS = {
    // Radio always busy: coalesce as much as fits.
    greedy: () => () => false,
    // Radio always idle: every write goes out on its own.
    single: () => () => true,
    // Anything in between.
    random: (rng) => () => rng() < 0.5,
};

export class FakeBluetoothDevice {
    constructor({fs = new FakeFilesystem(), maxPacketSize = 244, grouping = GROUPINGS.greedy(), version = 4} = {}) {
        this.fs = fs;
        this.maxPacketSize = maxPacketSize;
        this.grouping = grouping;
        this.device = new FakeDevice(fs, {maxPacketSize});
        this.listeners = {gattserverdisconnected: [], characteristicvaluechanged: []};
        this.notifications = [];
        this.connected = true;
        // Every notification the client was handed, for diagnostics.
        this.log = [];

        const self = this;
        const versionChar = {
            async readValue() {
                const v = new DataView(new ArrayBuffer(4));
                v.setUint32(0, version, true);
                return v;
            },
        };
        // Order of the connect-time calls, so tests can assert that the client
        // reads before it subscribes and stops before it starts.
        this.charCalls = [];
        this.transferChar = {
            addEventListener(type, fn) { self.listeners[type].push(fn); },
            removeEventListener(type, fn) {
                self.listeners[type] = self.listeners[type].filter((f) => f !== fn);
            },
            async readValue() {
                self.charCalls.push("readValue");
                if (self.readValueThrows) {
                    throw new Error("GATT operation not permitted");
                }
                return new DataView(new ArrayBuffer(0));
            },
            async stopNotifications() {
                self.charCalls.push("stopNotifications");
                if (self.stopNotificationsThrows) {
                    throw new Error("not subscribed");
                }
                return this;
            },
            async startNotifications() {
                self.charCalls.push("startNotifications");
                return this;
            },
            async writeValueWithoutResponse(value) { await self._deviceReceive(toBytes(value)); },
        };
        this.gatt = {
            async getPrimaryService(uuid) {
                if (uuid !== 0xfebb) {
                    throw new Error("no such service");
                }
                return {
                    async getCharacteristic(charUuid) {
                        if (charUuid.startsWith("adaf0100")) {
                            return versionChar;
                        }
                        if (charUuid.startsWith("adaf0200")) {
                            return self.transferChar;
                        }
                        throw new Error("no such characteristic " + charUuid);
                    },
                };
            },
        };
    }

    addEventListener(type, fn) { this.listeners[type].push(fn); }
    removeEventListener(type, fn) {
        this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
    }

    async _deviceReceive(packet) {
        if (!this.connected) {
            throw new Error("GATT server disconnected");
        }
        if (packet.byteLength > this.maxPacketSize) {
            throw new Error("client wrote " + packet.byteLength + " bytes, over the packet size");
        }
        const writes = this.device.receive(packet);
        for (const notification of groupWrites(writes, this.maxPacketSize, this.grouping)) {
            this._notify(notification);
        }
    }

    // Notifications arrive as separate tasks, like real BLE events. Set
    // duplicateNotifications to deliver each one twice, which is what Chrome on
    // Windows does when pairing happened during the connection.
    _notify(bytes) {
        this.log.push(bytes);
        const deliveries = this.duplicateNotifications ? 2 : 1;
        for (let i = 0; i < deliveries; i++) {
            setTimeout(() => {
                if (!this.connected) {
                    return;
                }
                const value = new DataView(bytes.slice().buffer);
                for (const fn of this.listeners.characteristicvaluechanged) {
                    fn({target: {value}});
                }
            }, 0);
        }
    }

    disconnect() {
        this.connected = false;
        for (const fn of this.listeners.gattserverdisconnected) {
            fn({});
        }
    }
}

// Rejects instead of hanging, so a never-settled promise is a test failure
// rather than a timeout of the whole run.
export function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("timed out after " + ms + "ms: " + what)), ms);
        }),
    ]);
}
