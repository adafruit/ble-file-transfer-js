// Reassembly tests for FileTransferClient.
//
// Every case drives the real client against test/fake-device.mjs, a byte-exact
// model of the CircuitPython service. The variable being swept is how the
// device's PacketBuffer writes get grouped into notifications, since on real
// hardware that depends on radio timing and is what turns a reassembly bug into
// an intermittent one. Run with `npm test`.

import {FileTransferClient} from "../adafruit-ble-file-transfer.js";
import {FakeFilesystem, makeRng} from "./fake-device.mjs";
import {FakeBluetoothDevice, GROUPINGS, withTimeout} from "./fake-ble.mjs";

// Packet sizes worth covering: 20 is the minimum a BLE link can offer and the
// size at which the device splits entry headers into 16 + 12; 27 is a 23 byte
// MTU without the split; 158 and 244 are typical negotiated sizes.
const PACKET_SIZES = [20, 27, 45, 158, 244];

let passed = 0;
const failures = [];
const unknownCommands = [];

// The client reports desynchronised reassembly by logging an unparseable
// opcode. Capture that rather than letting it scroll past.
const discarded = [];
const realLog = console.log;
console.log = (...args) => {
    const first = String(args[0]);
    if (first.startsWith("Unknown Command")) {
        unknownCommands.push(first);
        return;
    }
    if (first.startsWith("Discarding unexpected notification")) {
        discarded.push(first);
        return;
    }
    realLog(...args);
};

// A stray notification with no command pending makes the client call a null
// _resolve/_reject from a timer callback, which would otherwise take the whole
// run down instead of failing one case.
let currentTest = null;
const asyncErrors = [];
process.on("uncaughtException", (e) => {
    asyncErrors.push(`uncaught in ${currentTest}: ${String((e && e.stack) || e)}`);
});
process.on("unhandledRejection", (e) => {
    asyncErrors.push(`unhandled rejection in ${currentTest}: ${String((e && e.stack) || e)}`);
});

async function test(name, fn) {
    unknownCommands.length = 0;
    discarded.length = 0;
    asyncErrors.length = 0;
    currentTest = name;
    try {
        await fn();
        // Give any notification still in flight a chance to blow up here rather
        // than during an unrelated later test.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (asyncErrors.length > 0) {
            throw new Error(asyncErrors[0]);
        }
        if (unknownCommands.length > 0) {
            throw new Error("client logged " + JSON.stringify(unknownCommands));
        }
        passed++;
    } catch (e) {
        failures.push({name, error: String((e && e.message) || e)});
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(got, want, what) {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    assert(g === w, `${what}: got ${g}, want ${w}`);
}

function connect(fs, maxPacketSize, grouping) {
    const ble = new FakeBluetoothDevice({fs, maxPacketSize, grouping});
    return {ble, client: new FileTransferClient(ble)};
}

const sortedNames = (entries) => entries.map((e) => e.path).sort();
const expectedNames = (fs, path) =>
    fs.listdir(FakeFilesystem.normalize(path)).map((e) => e.name).sort();

// Every way the device could split this listing into notifications, not just a
// sample of them. Enumerating is only tractable for small listings, which is
// exactly where the off-by-one cases live.
function everyGrouping(writeCount) {
    const groupings = [];
    // Bit i decides whether to flush after write i.
    for (let mask = 0; mask < 1 << Math.min(writeCount, 16); mask++) {
        let i = 0;
        groupings.push(() => ((mask >> i++) & 1) === 1);
    }
    return groupings;
}

async function listDirWorks(fs, path, maxPacketSize, grouping, label) {
    const {client} = connect(fs, maxPacketSize, grouping);
    const entries = await withTimeout(client.listDir(path), 2000, label);
    assertEqual(sortedNames(entries), expectedNames(fs, path), label);
    return entries;
}

function fsWith(dirs, files) {
    const fs = new FakeFilesystem();
    for (const d of dirs) {
        fs.mkdir(d);
    }
    for (const [path, contents] of Object.entries(files)) {
        fs.writeAt(path, 0, new TextEncoder().encode(contents), 0n);
    }
    return fs;
}

// --- Issue #11: listDir() hangs forever on an empty directory ---------------
//
// An empty directory sends only the terminating entry (entry_number == 0,
// entry_count == 0, path_length == 0). The old completeness test consumed it
// and then waited for a second terminator that never comes.

for (const size of PACKET_SIZES) {
    for (const [gname, grouping] of Object.entries(GROUPINGS)) {
        await test(`empty directory resolves (packet ${size}, ${gname})`, async () => {
            const fs = fsWith(["/empty"], {});
            const entries = await listDirWorks(fs, "/empty", size, grouping(makeRng(1)), "empty dir");
            assertEqual(entries, [], "empty listing");
        });
    }
}

await test("empty directory resolves under every notification split", async () => {
    const fs = fsWith(["/empty"], {});
    // The terminator is one 28 byte write, or two when it has to be split.
    for (const size of [20, 244]) {
        for (const grouping of everyGrouping(2)) {
            await listDirWorks(fs, "/empty", size, grouping, `empty dir, packet ${size}`);
        }
    }
});

await test("empty directory does not poison the client", async () => {
    const fs = fsWith(["/empty"], {"/code.py": "print('hi')"});
    const {client} = connect(fs, 20, GROUPINGS.single());
    await withTimeout(client.listDir("/empty"), 2000, "empty dir");
    // A hung command leaves _reject set, and checkConnection() then throws
    // "Command in progress" for every later call.
    const entries = await withTimeout(client.listDir("/"), 2000, "root after empty dir");
    assertEqual(sortedNames(entries), expectedNames(fs, "/"), "root listing");
});

// --- Issue #12: response reassembly desynchronises -------------------------
//
// A listing whose last entry's header has arrived but whose name has not was
// declared complete, because the loop's bounds check used the previous entry's
// path length. The listing came back short or empty and the leftover name bytes
// were parsed as the next response's opcode.

await test("single entry with a name longer than the first packet", async () => {
    // 16 byte header packet + 20 byte packet leaves 8 of the 17 name bytes
    // received and 9 still in flight. This is the exact case from the issue.
    const fs = fsWith(["/lib"], {"/lib/adafruit_thing.py": "x"});
    await listDirWorks(fs, "/lib", 20, GROUPINGS.greedy(), "one long name");
});

await test("listing is complete under every notification split", async () => {
    const fs = fsWith([], {"/a.py": "x", "/bb.py": "x"});
    // 2 entries + terminator, split headers at packet size 20: at most 13 writes.
    for (const size of [20, 244]) {
        for (const grouping of everyGrouping(13)) {
            await listDirWorks(fs, "/", size, grouping, `two entries, packet ${size}`);
        }
    }
});

for (const size of PACKET_SIZES) {
    await test(`long and short names mixed (packet ${size})`, async () => {
        const fs = fsWith(["/lib"], {
            "/a": "x",
            "/code.py": "print('hi')",
            "/settings.toml": "x",
            "/a_rather_long_file_name_here.txt": "x",
            "/lib/adafruit_something_or_other.mpy": "x",
        });
        await listDirWorks(fs, "/", size, GROUPINGS.single(), "root");
        await listDirWorks(fs, "/lib", size, GROUPINGS.single(), "/lib");
    });
}

await test("non-ASCII filenames decode as UTF-8", async () => {
    // Filenames go out in 4 byte writes, so a multi-byte character can land
    // across two notifications. They are only decodable once reassembled.
    const fs = fsWith([], {"/caf\u00e9.py": "x", "/\u65e5\u672c\u8a9e.txt": "x", "/party-\u{1f389}.txt": "x"});
    for (const size of PACKET_SIZES) {
        await listDirWorks(fs, "/", size, GROUPINGS.single(), `utf-8 names, packet ${size}`);
    }
});

await test("nonexistent directory rejects without stray bytes", async () => {
    // The error entry is a full 28 byte header, split 16 + 12 at small packet
    // sizes. Rejecting after the first 16 leaves the other 12 to be parsed as
    // the start of the next response.
    for (const size of PACKET_SIZES) {
        const fs = fsWith([], {"/code.py": "x"});
        const {client} = connect(fs, size, GROUPINGS.single());
        let rejected = null;
        try {
            await withTimeout(client.listDir("/nope"), 2000, "bad path");
        } catch (e) {
            rejected = String((e && e.message) || e);
        }
        assert(rejected !== null, `packet ${size}: expected a rejection`);
        // A later command must still work.
        const entries = await withTimeout(client.listDir("/"), 2000, "root after bad path");
        assertEqual(sortedNames(entries), ["code.py"], `packet ${size}: root listing`);
    }
});

await test("a notification with no command pending is discarded", async () => {
    const fs = fsWith([], {"/code.py": "x"});
    const {ble, client} = connect(fs, 244, GROUPINGS.greedy());
    // Connect and settle a command, so the notification listener is live and
    // nothing is pending.
    await withTimeout(client.listDir("/"), 2000, "root");

    // A late status for a command that already gave up. Handing it to
    // processDeleteStatus() calls a null this._resolve.
    ble._notify(Uint8Array.from([0x31, 0x01]));
    // A fragment left over from a desync. Keeping its bytes prepends them to
    // whatever response arrives next.
    ble._notify(Uint8Array.from([0x51, 0x01, 0x00, 0x00]));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert(asyncErrors.length === 0, "stray notification threw: " + asyncErrors[0]);
    const entries = await withTimeout(client.listDir("/"), 2000, "root after strays");
    assertEqual(sortedNames(entries), ["code.py"], "root listing after strays");
    assertEqual(discarded.length, 2, "stray notifications discarded");
});

// --- Whole-session behaviour -----------------------------------------------
//
// A desync in one command shows up as a wrong result in the next one, so the
// sequence matters as much as any single response.

async function session(fs, maxPacketSize, grouping, label) {
    const {client} = connect(fs, maxPacketSize, grouping);
    const check = async (what, path) => {
        const entries = await withTimeout(client.listDir(path), 4000, `${label}: ${what}`);
        assertEqual(sortedNames(entries), expectedNames(fs, path), `${label}: ${what}`);
    };

    await check("initial root", "/");
    await check("initial /lib", "/lib");
    await check("initial /empty", "/empty");

    const contents = await withTimeout(client.readFile("/code.py"), 4000, `${label}: readFile`);
    assertEqual(contents, "print('hi')", `${label}: readFile /code.py`);

    await withTimeout(client.makeDir("/new"), 4000, `${label}: makeDir`);
    await check("root after makeDir", "/");

    await withTimeout(client.delete("/boot_out.txt"), 4000, `${label}: delete`);
    await check("root after delete", "/");

    await withTimeout(client.move("/code.py", "/main.py"), 4000, `${label}: move`);
    await check("root after move", "/");

    await withTimeout(client.writeFile("/notes.txt", 0, "hello there"), 8000, `${label}: writeFile`);
    await check("root after writeFile", "/");
    const written = await withTimeout(client.readFile("/notes.txt"), 4000, `${label}: readFile new`);
    assertEqual(written, "hello there", `${label}: readFile /notes.txt`);
}

function sessionFs() {
    return fsWith(["/lib", "/empty"], {
        "/code.py": "print('hi')",
        "/boot_out.txt": "Adafruit CircuitPython",
        "/lib/adafruit_thing.py": "x",
    });
}

for (const size of PACKET_SIZES) {
    for (const [gname, grouping] of Object.entries(GROUPINGS)) {
        await test(`editor session (packet ${size}, ${gname})`, async () => {
            await session(sessionFs(), size, grouping(makeRng(size)), `packet ${size} ${gname}`);
        });
    }
}

// --- Fuzz ------------------------------------------------------------------

const NAMES = ["a", "ab", "code.py", "boot.py", "x.txt", "settings.toml", "boot_out.txt",
    "a_rather_long_file_name_here.txt", "adafruit_some_library_or_other.mpy",
    "0123456789012345678901234567890123456789012345678901234567890123"];

await test("fuzz: random listings over random notification splits", async () => {
    for (let seed = 1; seed <= 400; seed++) {
        const rng = makeRng(seed);
        const fs = new FakeFilesystem();
        fs.mkdir("/sub");
        const count = Math.floor(rng() * 8);
        const used = new Set();
        for (let i = 0; i < count; i++) {
            const name = NAMES[Math.floor(rng() * NAMES.length)] + (used.size ? String(used.size) : "");
            used.add(name);
            if (rng() < 0.25) {
                fs.mkdir("/" + name);
            } else {
                fs.writeAt("/" + name, 0, new Uint8Array(3), 0n);
            }
        }
        const size = PACKET_SIZES[Math.floor(rng() * PACKET_SIZES.length)];
        const path = rng() < 0.2 ? "/sub" : "/";
        await listDirWorks(fs, path, size, GROUPINGS.random(rng), `seed ${seed} (packet ${size}, path ${path})`);
    }
});

console.log = realLog;
if (failures.length > 0) {
    for (const f of failures) {
        console.error(`FAIL  ${f.name}\n      ${f.error}`);
    }
    console.error(`\n${passed} passed, ${failures.length} failed`);
    process.exit(1);
}
console.log(`${passed} passed`);
