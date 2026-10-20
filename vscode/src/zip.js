'use strict';
/** Minimal ZIP writer (deflate, UTF-8 names) for folder attachments. */
const zlib = require('zlib');

const crc_table = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
});

function _crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) crc = crc_table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function _dos_date_time(date) {
    const year = Math.max(date.getFullYear(), 1980);
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

/**
 * Build a ZIP archive from entries [{name, data, mtime?}] and return it as Buffer.
 * No ZIP64: meant for attachments well below 4 GB.
 */
function create_zip(entries) {
    const local_parts = [];
    const central_parts = [];
    let offset = 0;
    for (const { name, data, mtime = new Date() } of entries) {
        const name_buffer = Buffer.from(name, 'utf8');
        const raw = Buffer.from(data);
        const deflated = zlib.deflateRawSync(raw);
        const method = deflated.length < raw.length ? 8 : 0;
        const body = method ? deflated : raw;
        const crc = _crc32(raw);
        const { time, date } = _dos_date_time(mtime);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name_buffer.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(name_buffer.length, 28);
        central.writeUInt32LE(offset, 42);
        local_parts.push(local, name_buffer, body);
        central_parts.push(central, name_buffer);
        offset += local.length + name_buffer.length + body.length;
    }
    const central_directory = Buffer.concat(central_parts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central_directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local_parts, central_directory, end]);
}

module.exports = { create_zip };
