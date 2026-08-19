// A byte-exact model of the CircuitPython BLE file transfer service.
//
// Mirrors supervisor/shared/bluetooth/file_transfer.c: the same response
// structs, the same order and size of PacketBuffer writes, and the same
// ANY_COMMAND/THIS_COMMAND reassembly of incoming commands. The point is to be
// able to drive the real FileTransferClient over every notification split the
// device can actually produce, which is what makes reassembly bugs
// reproducible instead of intermittent.

const READ = 0x10;
const READ_DATA = 0x11;
const READ_PACING = 0x12;
const WRITE = 0x20;
const WRITE_PACING = 0x21;
const WRITE_DATA = 0x22;
const DELETE = 0x30;
const DELETE_STATUS = 0x31;
const MKDIR = 0x40;
const MKDIR_STATUS = 0x41;
const LISTDIR = 0x50;
const LISTDIR_ENTRY = 0x51;
const MOVE = 0x60;
const MOVE_STATUS = 0x61;

const STATUS_OK = 0x01;
const STATUS_ERROR = 0x02;
const STATUS_ERROR_PROTOCOL = 0x04;

const ANY_COMMAND = 0x00;
const THIS_COMMAND = 0x01;

const COMMAND_SIZE = 1024;

const LISTDIR_ENTRY_SIZE = 28;
const READ_DATA_SIZE = 16;
const WRITE_PACING_SIZE = 20;
const MKDIR_STATUS_SIZE = 16;

// Deterministic PRNG so a failing fuzz case can be replayed from its seed.
export function makeRng(seed) {
    let s = seed >>> 0;
    return function next() {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 0x100000000;
    };
}

// An in-memory FAT-ish filesystem. Directories are tracked explicitly so that
// an empty directory exists, which is the case issue #11 is about.
export class FakeFilesystem {
    constructor() {
        this.dirs = new Set(["/"]);
        this.files = new Map(); // path -> {contents: Uint8Array, mtime: BigInt}
    }

    static normalize(path) {
        if (!path.startsWith("/")) {
            path = "/" + path;
        }
        while (path.length > 1 && path.endsWith("/")) {
            path = path.slice(0, -1);
        }
        return path;
    }

    parentOf(path) {
        const i = path.lastIndexOf("/");
        return i <= 0 ? "/" : path.slice(0, i);
    }

    exists(path) {
        return this.dirs.has(path) || this.files.has(path);
    }

    // Entries directly inside dir, in insertion order, like f_readdir.
    listdir(path) {
        if (!this.dirs.has(path)) {
            return null;
        }
        const entries = [];
        for (const d of this.dirs) {
            if (d !== "/" && this.parentOf(d) === path) {
                entries.push({name: d.slice(path === "/" ? 1 : path.length + 1), isDir: true, size: 0, mtime: 0n});
            }
        }
        for (const [f, info] of this.files) {
            if (this.parentOf(f) === path) {
                entries.push({
                    name: f.slice(path === "/" ? 1 : path.length + 1),
                    isDir: false,
                    size: info.contents.byteLength,
                    mtime: info.mtime,
                });
            }
        }
        return entries;
    }

    mkdir(path) {
        if (this.files.has(path)) {
            return false;
        }
        // Makes missing parents, like supervisor_workflow_mkdir().
        const parts = path.split("/").filter((p) => p.length > 0);
        let current = "";
        for (const part of parts) {
            current += "/" + part;
            if (this.files.has(current)) {
                return false;
            }
            this.dirs.add(current);
        }
        return true;
    }

    remove(path) {
        if (this.files.delete(path)) {
            return true;
        }
        if (!this.dirs.has(path) || path === "/") {
            return false;
        }
        // Recursive, like supervisor_workflow_delete_recursive().
        for (const d of [...this.dirs]) {
            if (d === path || d.startsWith(path + "/")) {
                this.dirs.delete(d);
            }
        }
        for (const f of [...this.files.keys()]) {
            if (f.startsWith(path + "/")) {
                this.files.delete(f);
            }
        }
        return true;
    }

    move(oldPath, newPath) {
        if (this.exists(newPath) || !this.exists(oldPath)) {
            return false;
        }
        if (!this.dirs.has(this.parentOf(newPath))) {
            return false;
        }
        if (this.files.has(oldPath)) {
            this.files.set(newPath, this.files.get(oldPath));
            this.files.delete(oldPath);
            return true;
        }
        for (const d of [...this.dirs]) {
            if (d === oldPath || d.startsWith(oldPath + "/")) {
                this.dirs.delete(d);
                this.dirs.add(newPath + d.slice(oldPath.length));
            }
        }
        for (const [f, info] of [...this.files]) {
            if (f.startsWith(oldPath + "/")) {
                this.files.delete(f);
                this.files.set(newPath + f.slice(oldPath.length), info);
            }
        }
        return true;
    }

    writeAt(path, offset, data, mtime) {
        if (!this.dirs.has(this.parentOf(path))) {
            return null;
        }
        const existing = this.files.get(path);
        const old = existing ? existing.contents : new Uint8Array(0);
        const contents = new Uint8Array(Math.max(old.byteLength, offset + data.byteLength));
        contents.set(old, 0);
        contents.set(data, offset);
        this.files.set(path, {contents, mtime});
        return contents;
    }

    truncate(path, length) {
        const info = this.files.get(path);
        if (info && info.contents.byteLength > length) {
            info.contents = info.contents.slice(0, length);
        }
    }
}

// The device side of the link.
//
// Commands arrive one BLE packet at a time and are accumulated exactly the way
// supervisor_bluetooth_file_transfer_background() does. Responses are produced
// as a list of PacketBuffer writes; grouping those writes into notifications is
// left to the transport, because on real hardware that grouping depends on
// radio timing and is the variable these tests need to sweep.
export class FakeDevice {
    constructor(fs, {maxPacketSize = 244} = {}) {
        this.fs = fs;
        this.maxPacketSize = maxPacketSize;
        this.currentCommand = new Uint8Array(COMMAND_SIZE);
        this.currentOffset = 0;
        this.nextCommand = ANY_COMMAND;
        this.writes = [];
        this.activeFile = null;
        this.activeOffset = 0;
        this.totalWriteLength = 0;
        this.truncatedTime = 0n;
    }

    _write(bytes) {
        if (bytes.byteLength > this.maxPacketSize) {
            throw new Error("device write larger than outgoing_packet_length");
        }
        this.writes.push(bytes);
    }

    // Accepts one command packet, returns the PacketBuffer writes it produced.
    receive(packet) {
        this.writes = [];
        this.currentCommand.set(packet, this.currentOffset);
        this.currentOffset += packet.byteLength;
        const currentState = this.currentCommand[0];
        if (this.nextCommand !== ANY_COMMAND && this.nextCommand !== THIS_COMMAND &&
            (currentState & 0xf) !== 0 && currentState !== this.nextCommand) {
            this._write(Uint8Array.from([this.nextCommand, STATUS_ERROR_PROTOCOL]));
            return this.writes;
        }
        const buf = this.currentCommand.subarray(0, this.currentOffset);
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        switch (currentState) {
            case READ: this.nextCommand = this._processRead(view); break;
            case READ_PACING: this.nextCommand = this._processReadPacing(view); break;
            case WRITE: this.nextCommand = this._processWrite(view); break;
            case WRITE_DATA: this.nextCommand = this._processWriteData(view); break;
            case DELETE: this.nextCommand = this._processDelete(view); break;
            case MKDIR: this.nextCommand = this._processMkdir(view); break;
            case LISTDIR: this.nextCommand = this._processListdir(view); break;
            case MOVE: this.nextCommand = this._processMove(view); break;
            default: throw new Error("device got unknown command 0x" + currentState.toString(16));
        }
        if (this.nextCommand !== THIS_COMMAND) {
            this.currentOffset = 0;
        }
        return this.writes;
    }

    _path(view, start, length) {
        const bytes = new Uint8Array(view.buffer, view.byteOffset + start, length);
        return FakeFilesystem.normalize(new TextDecoder().decode(bytes));
    }

    // Splits into 16 + 12 below the 28 byte struct size, like
    // send_listdir_entry_header().
    _sendListdirEntryHeader(entry) {
        if (this.maxPacketSize >= LISTDIR_ENTRY_SIZE) {
            this._write(entry);
            return;
        }
        this._write(entry.slice(0, 16));
        this._write(entry.slice(16));
    }

    _listdirEntry({status = STATUS_OK, pathLength = 0, entryNumber = 0, entryCount = 0, flags = 0, mtime = 0n, fileSize = 0}) {
        const b = new Uint8Array(LISTDIR_ENTRY_SIZE);
        const v = new DataView(b.buffer);
        v.setUint8(0, LISTDIR_ENTRY);
        v.setUint8(1, status);
        v.setUint16(2, pathLength, true);
        v.setUint32(4, entryNumber, true);
        v.setUint32(8, entryCount, true);
        v.setUint32(12, flags, true);
        v.setBigUint64(16, mtime, true);
        v.setUint32(24, fileSize, true);
        return b;
    }

    _processListdir(view) {
        const headerSize = 4;
        const pathLength = view.getUint16(2, true);
        if (pathLength > COMMAND_SIZE - headerSize - 1) {
            this._sendListdirEntryHeader(this._listdirEntry({status: STATUS_ERROR}));
            return ANY_COMMAND;
        }
        if (view.byteLength < headerSize + pathLength) {
            return THIS_COMMAND;
        }
        const path = this._path(view, headerSize, pathLength);
        const entries = this.fs.listdir(path);
        if (entries === null) {
            this._sendListdirEntryHeader(this._listdirEntry({status: STATUS_ERROR}));
            return ANY_COMMAND;
        }
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const name = new TextEncoder().encode(e.name);
            this._sendListdirEntryHeader(this._listdirEntry({
                pathLength: name.byteLength,
                entryNumber: i,
                entryCount: entries.length,
                flags: e.isDir ? 1 : 0,
                mtime: e.mtime,
                fileSize: e.size,
            }));
            // The device dribbles the filename out in 4 byte writes.
            for (let o = 0; o < name.byteLength; o += 4) {
                this._write(name.slice(o, Math.min(o + 4, name.byteLength)));
            }
        }
        // Terminating entry: entry_number == entry_count, path_length == 0.
        this._sendListdirEntryHeader(this._listdirEntry({
            entryNumber: entries.length,
            entryCount: entries.length,
        }));
        return ANY_COMMAND;
    }

    _processMkdir(view) {
        const headerSize = 16;
        const pathLength = view.getUint16(2, true);
        const respond = (status) => {
            const b = new Uint8Array(MKDIR_STATUS_SIZE);
            const v = new DataView(b.buffer);
            v.setUint8(0, MKDIR_STATUS);
            v.setUint8(1, status);
            this._write(b);
        };
        if (pathLength > COMMAND_SIZE - headerSize - 1) {
            respond(STATUS_ERROR);
            return ANY_COMMAND;
        }
        if (view.byteLength < headerSize + pathLength) {
            return THIS_COMMAND;
        }
        respond(this.fs.mkdir(this._path(view, headerSize, pathLength)) ? STATUS_OK : STATUS_ERROR);
        return ANY_COMMAND;
    }

    _processDelete(view) {
        const headerSize = 4;
        const pathLength = view.getUint16(2, true);
        if (view.byteLength < headerSize + pathLength) {
            return THIS_COMMAND;
        }
        const ok = this.fs.remove(this._path(view, headerSize, pathLength));
        this._write(Uint8Array.from([DELETE_STATUS, ok ? STATUS_OK : STATUS_ERROR]));
        return ANY_COMMAND;
    }

    _processMove(view) {
        const headerSize = 6;
        const oldLength = view.getUint16(2, true);
        const newLength = view.getUint16(4, true);
        // +1 for the reserved separator byte between the two paths.
        if (view.byteLength < headerSize + oldLength + newLength + 1) {
            return THIS_COMMAND;
        }
        const oldPath = this._path(view, headerSize, oldLength);
        const newPath = this._path(view, headerSize + oldLength + 1, newLength);
        const ok = this.fs.move(oldPath, newPath);
        this._write(Uint8Array.from([MOVE_STATUS, ok ? STATUS_OK : STATUS_ERROR]));
        return ANY_COMMAND;
    }

    _readDataHeader(status, chunkOffset, totalLength, dataSize) {
        const b = new Uint8Array(READ_DATA_SIZE);
        const v = new DataView(b.buffer);
        v.setUint8(0, READ_DATA);
        v.setUint8(1, status);
        v.setUint32(4, chunkOffset, true);
        v.setUint32(8, totalLength, true);
        v.setUint32(12, dataSize, true);
        return b;
    }

    _processRead(view) {
        const headerSize = 12;
        const pathLength = view.getUint16(2, true);
        if (view.byteLength < headerSize + pathLength) {
            return THIS_COMMAND;
        }
        const path = this._path(view, headerSize, pathLength);
        const info = this.fs.files.get(path);
        if (!info) {
            this._write(this._readDataHeader(STATUS_ERROR, 0, 0, 0));
            return ANY_COMMAND;
        }
        this.activeFile = path;
        const totalLength = info.contents.byteLength;
        const offset = view.getUint32(4, true);
        const chunkSize = Math.min(view.getUint32(8, true), totalLength - offset);
        this._write(this._readDataHeader(STATUS_OK, offset, totalLength, chunkSize));
        // Contents go out in 16 byte writes, matching sizeof(struct read_data).
        for (let o = offset; o < offset + chunkSize; o += READ_DATA_SIZE) {
            this._write(info.contents.slice(o, Math.min(o + READ_DATA_SIZE, offset + chunkSize)));
        }
        return offset + chunkSize >= totalLength ? ANY_COMMAND : READ_PACING;
    }

    _processReadPacing(view) {
        if (view.byteLength < 12) {
            return THIS_COMMAND;
        }
        const info = this.fs.files.get(this.activeFile);
        const totalLength = info.contents.byteLength;
        const chunkOffset = view.getUint32(4, true);
        const chunkSize = Math.min(view.getUint32(8, true), totalLength - chunkOffset);
        this._write(this._readDataHeader(STATUS_OK, chunkOffset, totalLength, chunkSize));
        // Read pacing dribbles contents out in 20 byte writes.
        for (let o = chunkOffset; o < chunkOffset + chunkSize; o += 20) {
            this._write(info.contents.slice(o, Math.min(o + 20, chunkOffset + chunkSize)));
        }
        return chunkOffset + chunkSize >= totalLength ? ANY_COMMAND : READ_PACING;
    }

    _writePacing(status, offset, freeSpace) {
        const b = new Uint8Array(WRITE_PACING_SIZE);
        const v = new DataView(b.buffer);
        v.setUint8(0, WRITE_PACING);
        v.setUint8(1, status);
        v.setUint32(4, offset, true);
        v.setBigUint64(8, this.truncatedTime, true);
        v.setUint32(16, freeSpace, true);
        this._write(b);
    }

    _processWrite(view) {
        const headerSize = 20;
        const pathLength = view.getUint16(2, true);
        if (view.byteLength < headerSize + pathLength) {
            return THIS_COMMAND;
        }
        const offset = view.getUint32(4, true);
        this.truncatedTime = view.getBigUint64(8, true);
        this.totalWriteLength = view.getUint32(16, true);
        const path = this._path(view, headerSize, pathLength);
        if (!this.fs.dirs.has(this.fs.parentOf(path))) {
            this._writePacing(STATUS_ERROR, 0, 0);
            return ANY_COMMAND;
        }
        this.activeFile = path;
        this.activeOffset = offset;
        if (!this.fs.files.has(path)) {
            this.fs.writeAt(path, 0, new Uint8Array(0), this.truncatedTime);
        }
        // The first chunk is aligned to the end of its 512 byte sector.
        const chunkSize = Math.min(this.totalWriteLength - offset, 512 - (offset % 512));
        this._writePacing(STATUS_OK, offset, chunkSize);
        if (chunkSize === 0) {
            this.fs.truncate(path, offset);
            return ANY_COMMAND;
        }
        return WRITE_DATA;
    }

    _processWriteData(view) {
        const headerSize = 12;
        const dataSize = view.getUint32(8, true);
        if (view.byteLength < headerSize + dataSize) {
            return THIS_COMMAND;
        }
        let offset = view.getUint32(4, true);
        const data = new Uint8Array(view.buffer, view.byteOffset + headerSize, dataSize);
        this.fs.writeAt(this.activeFile, offset, data, this.truncatedTime);
        offset += dataSize;
        const chunkSize = Math.min(this.totalWriteLength - offset, 512);
        this._writePacing(STATUS_OK, offset, chunkSize);
        if (this.totalWriteLength === offset) {
            this.fs.truncate(this.activeFile, offset);
            return ANY_COMMAND;
        }
        return WRITE_DATA;
    }
}
