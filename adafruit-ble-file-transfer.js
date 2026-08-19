const bleFileCharVersionUUID = 'adaf0100-4669-6c65-5472-616e73666572';
const bleFileCharTransferUUID = 'adaf0200-4669-6c65-5472-616e73666572';

const ANY_COMMAND = 0;
const THIS_COMMAND = 1;
const READ_COMMAND = 0x10;
const READ_DATA = 0x11;
const READ_PACING = 0x12;
const WRITE_COMMAND = 0x20;
const WRITE_PACING = 0x21;
const WRITE_DATA = 0x22;
const DELETE_COMMAND = 0x30;
const DELETE_STATUS = 0x31;
const MKDIR_COMMAND = 0x40;
const MKDIR_STATUS = 0x41;
const LISTDIR_COMMAND = 0x50;
const LISTDIR_ENTRY = 0x51;
const MOVE_COMMAND = 0x60;
const MOVE_STATUS = 0x61;

const STATUS_OK = 0x01;
const STATUS_ERROR = 0x02;
const STATUS_ERROR_READONLY = 0x05;

// Flags
const FLAG_DIRECTORY = 0x01;

// 500 works on mac
const BYTES_PER_WRITE = 20;

class FileTransferClient {
    constructor(bleDevice, bufferSize = 4096) {
        this._resolve = null;
        this._reject = null;
        this._command = ANY_COMMAND;
        this._offset = 0;
        // We have a ton of memory so just buffer everything :-)
        this._buffer = new Uint8Array(bufferSize);
        this._transfer = null;
        this._device = bleDevice;
        this._raw = false;
        bleDevice.addEventListener("gattserverdisconnected", this.onDisconnected.bind(this));
        this._onTransferNotify = this.onTransferNotify.bind(this);
    }

    async onDisconnected() {
        //ftc disconnected;
        this._transfer = null;
        if (this._reject != null) {
            this._reject("disconnected");
            this._reject = null;
            this._resolve = null;
        }
        this._command = ANY_COMMAND;
        this._offset = 0;
    }

    async checkConnection() {
        if (this._reject != null) {
            throw "Command in progress";
        }
        if (this._transfer != null) {
            //connection ok
            return;
        }
        try {
            //check connection
            let service = await this._device.gatt.getPrimaryService(0xfebb);
            const versionChar = await service.getCharacteristic(bleFileCharVersionUUID);
            let version = (await versionChar.readValue()).getUint32(0, true);
            if (version != 4) {
                return Promise.reject("Unsupported version: " + version);
            }
            //version ok
            this._transfer = await service.getCharacteristic(bleFileCharTransferUUID);
            this._transfer.removeEventListener('characteristicvaluechanged', this._onTransferNotify);
            this._transfer.addEventListener('characteristicvaluechanged', this._onTransferNotify);
            await this._transfer.startNotifications();
        } catch (e) {
            console.log("caught connection error", e, e.stack);
            this.onDisconnected();
            // Rethrow. Returning normally here leaves _transfer null and lets
            // the caller go on to write a request that cannot be sent.
            throw e;
        }
    }

    // Install the promise that the response notification will settle.
    //
    // This must happen BEFORE the request is written. _write() reports a failed
    // write by calling onDisconnected(), which can only reject if _reject is
    // already set; otherwise the failure is swallowed and the promise returned
    // to the caller is never settled by anyone. It also closes a race where a
    // device that answers immediately could deliver its notification before
    // _resolve existed.
    _pendingResponse() {
        return new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    async _write(value) {
        try {
            if (value.byteLength < BYTES_PER_WRITE) {
                await this._transfer.writeValueWithoutResponse(value);
                return;
            }
            var offset = 0;
            while (offset < value.byteLength) {
                let len = Math.min(value.byteLength - offset, BYTES_PER_WRITE);
                let chunk_contents = value.slice(offset, offset + len);
                // Delay to ensure the last value was written to the device.
                await this.sleep(100);
                await this._transfer.writeValueWithoutResponse(chunk_contents);
                offset += len;
            }
        } catch (e) {
            console.log("caught write error", e, e.stack);
            this.onDisconnected();
            // Rethrow. Swallowing it let the caller go on to write the rest of
            // the request against a now-null _transfer, which threw a second,
            // misleading error.
            throw e;
        }
    }

    // Write the parts of one request, stopping at the first failure.
    //
    // A failed write has already rejected the pending response via
    // onDisconnected(), so there is nothing to report here; returning the
    // rejection as well would leave that promise unhandled. Sending the
    // remaining parts of a request known to be broken only makes things worse:
    // the device stays in THIS_COMMAND holding the part that did arrive, and
    // prepends it to whatever request comes next.
    async _writeRequest(...parts) {
        try {
            for (let part of parts) {
                await this._write(part);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    async bond() {
        await this.checkConnection();
        //bonded internally
    }

    async onTransferNotify(event) {
        if (this._resolve == null) {
            // No command is waiting for this. Parsing it would call a null
            // _resolve or _reject and throw out of the event handler, and
            // keeping the bytes would prepend them to the next command's
            // response. Drop it, but say so: a stray notification means the
            // device and this client disagree about where a response ended.
            console.log("Discarding unexpected notification of " + event.target.value.byteLength + " bytes");
            this._offset = 0;
            return;
        }
        this._buffer.set(new Uint8Array(event.target.value.buffer), this._offset);
        this._command = this._buffer[0];
        this._offset += event.target.value.byteLength;
        if (this._command == READ_DATA) {
            this._command = await this.processReadData(new DataView(this._buffer.buffer, 0, this._offset));
        } else if (this._command == WRITE_PACING) {
            this._command = await this.processWritePacing(new DataView(this._buffer.buffer, 0, this._offset));
        } else if (this._command == LISTDIR_ENTRY) {
            this._command = await this.processListDirEntry(new DataView(this._buffer.buffer, 0, this._offset));
        } else if (this._command == MKDIR_STATUS) {
            this._command = await this.processMkDirStatus(new DataView(this._buffer.buffer, 0, this._offset));
        } else if (this._command == DELETE_STATUS) {
            this._command = await this.processDeleteStatus(new DataView(this._buffer.buffer, 0, this._offset));
        } else if (this._command == MOVE_STATUS) {
            this._command = await this.processMoveStatus(new DataView(this._buffer.buffer, 0, this._offset));
        } else {
            console.log("Unknown Command: " + this._command);
        }
        if (this._command != THIS_COMMAND) {
            //reset buffer
            this._offset = 0;
        }
    }

    async readFile(filename, raw = false) {
        await this.checkConnection();
        this._incomingFile = null;
        this._incomingOffset = 0;
        this._raw = raw;

        var header = new ArrayBuffer(12);
        var view = new DataView(header);
        let encoded = new TextEncoder().encode(filename);
        view.setUint8(0, READ_COMMAND);
        // Offset 1 is reserved
        view.setUint16(2, encoded.byteLength, true);
        view.setUint32(4, 0, true);
        view.setUint32(8, this._buffer.byteLength - 16, true);
        let p = this._pendingResponse();
        await this._writeRequest(header, encoded);
        //read return
        return p;
    }

    async writeFile(path, offset, contents, modificationTime, raw = false) {
        let encoder = new TextEncoder();

        if (!raw) {
            let same = contents.slice(0, offset);
            let different = contents.slice(offset);
            offset = encoder.encode(same).byteLength;
            contents = encoder.encode(different);
        } else if (!(contents instanceof Uint8Array)) {
            contents = new Uint8Array(contents);
        }

        await this.checkConnection();
        if (modificationTime === undefined) {
            modificationTime = Date.now();
        }
        var header = new ArrayBuffer(20);
        var view = new DataView(header);
        let encoded = new TextEncoder().encode(path);
        view.setUint8(0, WRITE_COMMAND);
        // Offset 1 is reserved
        view.setUint16(2, encoded.byteLength, true);
        view.setUint32(4, offset, true);
        view.setBigUint64(8, BigInt(modificationTime * 1000000), true);
        view.setUint32(16, offset + contents.byteLength, true);
        // Set before writing: processWritePacing() reads these, and the first
        // pacing notification can arrive as soon as the header is out.
        this._outgoingContents = contents;
        this._outgoingOffset = offset;
        let p = this._pendingResponse();
        await this._writeRequest(header, encoded);
        //write return
        return p;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async processWritePacing(payload) {
        let status = payload.getUint8(1);
        // Two bytes of padding.
        let chunkOffset = payload.getUint32(4, true);
        let freeSpace = payload.getUint32(16, true);
        if (status != STATUS_OK) {
            if (status == STATUS_ERROR_READONLY) {
                this._reject("Filesystem is read-only");
            } else if (status == STATUS_ERROR) {
                this._reject("Invalid Path");
            } else {
                this._reject("Unknown Status: " + status);
            }
            this._reject = null;
            this._resolve = null;
            return ANY_COMMAND;
        }
        if (freeSpace == 0) {
            this._resolve();
            this._reject = null;
            this._resolve = null;
            return ANY_COMMAND;
        }
        var header = new ArrayBuffer(12);
        var view = new DataView(header);
        view.setUint8(0, WRITE_DATA);
        view.setUint8(1, STATUS_OK);
        // Offsets 2 and 3 are reserved
        view.setUint32(4, chunkOffset, true);
        let remaining = Math.min(this._outgoingOffset + this._outgoingContents.byteLength - chunkOffset, freeSpace);
        view.setUint32(8, remaining, true);
        let baseOffset = chunkOffset - this._outgoingOffset;
        if (!await this._writeRequest(header, this._outgoingContents.subarray(baseOffset, baseOffset + remaining))) {
            return ANY_COMMAND;
        }
        return WRITE_PACING;
    }

    async processReadData(payload) {
        const headerSize = 16;
        let status = payload.getUint8(1);
        let chunkOffset = payload.getUint32(4, true);
        let totalLength = payload.getUint32(8, true);
        let chunkLength = payload.getUint32(12, true);
        if (status != STATUS_OK) {
            if (status == STATUS_ERROR_READONLY) {
                this._reject("Filesystem is read-only");
            } else if (status == STATUS_ERROR) {
                this._reject("Invalid Path");
            } else {
                this._reject("Unknown Status: " + status);
            }
            this._resolve = null;
            this._reject = null;
            this._incomingFile = null;
            this._incomingOffset = 0;
            return ANY_COMMAND;
        }
        if (payload.byteLength < headerSize + chunkLength) {
            // need more
            return THIS_COMMAND;
        }
        // full payload
        if (this._incomingFile == null) {
            this._incomingFile = new Uint8Array(totalLength);
        }
        this._incomingFile.set(new Uint8Array(payload.buffer.slice(headerSize, payload.byteLength)), chunkOffset);
        this._incomingOffset += chunkLength;

        let remaining = this._incomingFile.byteLength - this._incomingOffset;
        if (remaining == 0) {
            if (this._raw) {
                this._resolve(new Blob([this._incomingFile]));
            } else {
                this._resolve(new TextDecoder().decode(this._incomingFile));
            }
            this._resolve = null;
            this._reject = null;
            this._incomingFile = null;
            this._incomingOffset = 0;
            return ANY_COMMAND;
        }
        var header = new ArrayBuffer(12);
        var view = new DataView(header);
        view.setUint8(0, READ_PACING);
        view.setUint8(1, STATUS_OK);
        // Offsets 2 and 3 are reserved
        view.setUint32(4, this._incomingOffset, true);
        view.setUint32(8, Math.min(this._buffer.byteLength - 12, remaining), true);
        if (!await this._writeRequest(header)) {
            return ANY_COMMAND;
        }
        return READ_DATA;
    }

    async processListDirEntry(payload) {
        const headerSize = 28;
        // The device splits an entry header into 16 + 12 byte writes when it
        // does not fit in a single packet, so nothing in the header can be
        // trusted -- not even the status byte -- until all of it has arrived.
        // Deciding anything sooner resolves the command while the rest of the
        // header is still in flight, and those bytes are then parsed as the
        // start of the next response.
        if (payload.byteLength < headerSize) {
            return THIS_COMMAND;
        }

        let status = payload.getUint8(1);
        if (status != STATUS_OK) {
            if (status == STATUS_ERROR_READONLY) {
                this._reject("Filesystem is read-only");
            } else if (status == STATUS_ERROR) {
                this._reject("Invalid Path");
            } else {
                this._reject("Unknown Status: " + status);
            }
            this._resolve = null;
            this._reject = null;
            return ANY_COMMAND;
        }

        // Figure out if complete. A listing ends with a terminating entry whose
        // entry_number equals entry_count and whose path_length is zero. An
        // empty directory sends that entry and nothing else, so the terminator
        // is the only reliable end marker; running out of bytes is not one.
        let offset = 0;
        let complete = false;
        while (offset + headerSize <= payload.byteLength) {
            let pathLength = payload.getUint16(offset + 2, true);
            let entryNumber = payload.getUint32(offset + 4, true);
            let entryCount = payload.getUint32(offset + 8, true);
            if (entryNumber >= entryCount) {
                complete = true;
                break;
            }
            if (offset + headerSize + pathLength > payload.byteLength) {
                // This entry's name is still arriving.
                break;
            }
            offset += headerSize + pathLength;
        }
        if (!complete) {
            // need more
            return THIS_COMMAND;
        }

        // full payload, now process it
        let paths = [];
        let b = this._buffer.buffer;
        // Paths are UTF-8 on the wire, the same encoding this client uses when
        // it sends one.
        let decoder = new TextDecoder();
        offset = 0;
        while (offset + headerSize <= payload.byteLength) {
            let cmd = payload.getUint8(offset + 0);
            if (cmd != LISTDIR_ENTRY) {
                this._reject(new ProtocolError("Expected LISTDIR_ENTRY, got 0x" + cmd.toString(16)));
                this._resolve = null;
                this._reject = null;
                return ANY_COMMAND;
            }
            let pathLength = payload.getUint16(offset + 2, true);
            let entryNumber = payload.getUint32(offset + 4, true);
            let entryCount = payload.getUint32(offset + 8, true);
            if (entryNumber >= entryCount) {
                // The terminating entry carries no path.
                break;
            }
            let flags = payload.getUint32(offset + 12, true);
            let modificationTime = payload.getBigUint64(offset + 16, true);
            let fileSize = payload.getUint32(offset + 24, true);
            let path = decoder.decode(new Uint8Array(b, offset + headerSize, pathLength));
            paths.push({
                path: path,
                isDir: !!(flags & FLAG_DIRECTORY),
                fileSize: fileSize,
                fileDate: Number(modificationTime / BigInt(1000000)),
            });
            offset += headerSize + pathLength;
        }

        this._resolve(paths);
        this._resolve = null;
        this._reject = null;
        return ANY_COMMAND;
    }

    async processMkDirStatus(payload) {
        const headerSize = 16;
        let status = payload.getUint8(1);

        if (payload.byteLength < headerSize) {
            return THIS_COMMAND;
        }

        if (status != STATUS_OK) {
            if (status == STATUS_ERROR_READONLY) {
                this._reject("Filesystem is read-only");
            } else if (status == STATUS_ERROR) {
                this._reject("Invalid Path");
            } else {
                this._reject("Unknown Status: " + status);
            }
        } else {
            this._resolve(true);
        }

        this._resolve = null;
        this._reject = null;
        return ANY_COMMAND;
    }

    async processDeleteStatus(payload) {
        const headerSize = 2;

        if (payload.byteLength < headerSize) {
            return THIS_COMMAND;
        }

        let status = payload.getUint8(1);
        if (status != STATUS_OK) {
            if (status == STATUS_ERROR_READONLY) {
                this._reject("Filesystem is read-only");
            } else if (status == STATUS_ERROR) {
                this._reject("File or Folder not found");
            } else {
                this._reject("Unknown Status: " + status);
            }
        } else {
            this._resolve(true);
        }

        this._resolve = null;
        this._reject = null;
        return ANY_COMMAND;
    }

    async processMoveStatus(payload) {
        const headerSize = 2;

        if (payload.byteLength < headerSize) {
            return THIS_COMMAND;
        }

        let status = payload.getUint8(1);
        if (status != STATUS_OK) {
            if (status == STATUS_ERROR_READONLY) {
                this._reject("Filesystem is read-only");
            } else if (status == STATUS_ERROR) {
                this._reject("Unable to move file");
            } else {
                this._reject("Unknown Status: " + status);
            }
        } else {
            this._resolve(true);
        }
        this._resolve = null;
        this._reject = null;
        return ANY_COMMAND;
    }

    // Makes the directory and any missing parents
    async makeDir(path, modificationTime) {
        await this.checkConnection();
        if (modificationTime === undefined) {
            modificationTime = Date.now();
        }
        let encoded = new TextEncoder().encode(path);
        var header = new ArrayBuffer(16);
        var view = new DataView(header);
        view.setUint8(0, MKDIR_COMMAND);
        // Offset 1 is reserved
        view.setUint16(2, encoded.byteLength, true);
        // Offsets 4-7 Reserved
        view.setBigUint64(8, BigInt(modificationTime * 1000000), true);
        let p = this._pendingResponse();
        await this._writeRequest(header, encoded);
        return p;
    }

    // Returns a list of tuples, one tuple for each file or directory in the given path
    async listDir(path) {
        await this.checkConnection();
        let encoded = new TextEncoder().encode(path);
        var header = new ArrayBuffer(4);
        var view = new DataView(header);
        view.setUint8(0, LISTDIR_COMMAND);
        // Offset 1 is reserved
        view.setUint16(2, encoded.byteLength, true);
        let p = this._pendingResponse();
        await this._writeRequest(header, encoded);
        return p;
    }

    // Deletes the file or directory at the given path. Directories must be empty.
    async delete(path) {
        await this.checkConnection();
        let encoded = new TextEncoder().encode(path);
        var header = new ArrayBuffer(4);
        var view = new DataView(header);
        view.setUint8(0, DELETE_COMMAND);
        // Offset 1 is reserved
        view.setUint16(2, encoded.byteLength, true);
        let p = this._pendingResponse();
        await this._writeRequest(header, encoded);
        return p;
    }

    // Moves the file or directory from oldPath to newPath.
    async move(oldPath, newPath) {
        await this.checkConnection();

        let encodedOldPath = new TextEncoder().encode(oldPath);
        let encodedNewPath = new TextEncoder().encode(newPath);

        var header = new ArrayBuffer(6);
        var view = new DataView(header);
        view.setUint8(0, MOVE_COMMAND);
        // Offset 1 is reserved
        view.setUint16(2, encodedOldPath.byteLength, true);
        view.setUint16(4, encodedNewPath.byteLength, true);
        let p = this._pendingResponse();
        await this._writeRequest(header, encodedOldPath, new TextEncoder().encode(" "), encodedNewPath);
        return p;
    }
}
class ProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProtocolError";
    }
}

class ValueError extends Error {
    constructor(message) {
        super(message);
        this.name = "ValueError";
    }
}

export {FileTransferClient, ProtocolError, ValueError};
